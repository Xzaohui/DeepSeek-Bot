import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { lineText } from '../src/host/groups.js'
import { fakeContext } from './fake-ctx.js'

// A relay's round runs inside the group Session's own turn; a restart, a stop or a
// fresh part can cut that turn between two speakers. The calls the round had queued
// but not reached must park like the relay limit parks calls, and the log must say
// so — a call never disappears in silence (#N2, 2026-10-24).
const TEAM = {
  version: 1,
  mainBotIds: ['a'],
  workspaceId: 'w1',
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
    c: { id: 'c', name: 'Coder', role: 'Code', sessionId: 'c', createdAt: 3 },
  },
  rooms: { r1: { id: 'r1', name: 'Ops', named: true, members: ['a', 'b', 'c'], admin: 'a', mode: 'admin', notice: '' } },
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
}

async function start(team = TEAM) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ds-bot-room-cut-')))
  const home = join(root, 'bot')
  const folder = join(root, 'project')
  for (const dir of [home, folder]) mkdirSync(dir)
  writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  const ctx = fakeContext()
  let sessions = 0
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: {
      get: id => (id === 'w1' ? { id: 'w1', path: home } : undefined),
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w1', path }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: `s${++sessions}` }),
      resolveAgent: async sessionId => ({ agent: { id: sessionId, session: { id: sessionId }, followup() {} } }),
      selectModel: async () => {},
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home })
  await rt.load()
  const saved = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  const relay = (posts, signal) => {
    for (const [id, items] of posts) rt.roomInbox.set(id, items)
    const cut = new AbortController()
    if (signal === 'cut') cut.abort()
    return ctx.registeredTools.get('group_relay').execute({}, { agent: { id: 'r1' }, signal: cut.signal, callId: 'call-1' })
  }
  const stop = async () => {
    await ctx.dispose()
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  }
  return { rt, ctx, saved, relay, stop }
}

test('a round cut before it reaches the called member parks the call and leaves a notice', async (t) => {
  const { rt, saved, relay, stop } = await start()
  t.after(stop)
  await relay(new Map([['r1', [{ text: '@Coder 交报告' }]]]), 'cut')
  const room = rt.state.rooms.r1
  assert.deepEqual(room.paused, [{ id: 'c', name: 'Coder' }])
  const notice = room.log.at(-1)
  assert.deepEqual([notice.who, notice.kind, notice.reason, notice.names], ['DS Bot', 'notice', 'cut', ['Coder']])
  assert.match(lineText(notice), /@Coder/)
  assert.match(lineText(notice), /cut off/)
  // The parked call survives the restart the cut stands for: it is in the saved team.
  assert.deepEqual(saved().rooms.r1.paused, [{ id: 'c', name: 'Coder' }])
})

test('a Continue after the cut releases the parked call into the next round, and a cut of that round parks it once', async (t) => {
  const { rt, relay, stop } = await start()
  t.after(stop)
  await relay(new Map([['r1', [{ text: '@Coder 交报告' }]]]), 'cut')
  await relay(new Map([['r1', [{ text: '', resume: true }]]]), 'cut')
  const room = rt.state.rooms.r1
  const parked = (room.paused ?? []).map(entry => entry.id)
  assert.deepEqual(parked, ['c'])
  // One notice per cut, each naming the call it parked.
  const notices = room.log.filter(line => line.reason === 'cut')
  assert.deepEqual(notices.map(line => line.names), [['Coder'], ['Coder']])
})

test('a round with no speakers to reach parks nothing', async (t) => {
  const { rt, relay, stop } = await start()
  t.after(stop)
  // A quiet post (a progress reminder) opens no speaker slots; cutting it parks
  // nothing and leaves no notice.
  await relay(new Map([['r1', [{ text: '', quiet: true }]]]), 'cut')
  assert.equal(rt.state.rooms.r1.paused, undefined)
  assert.equal(rt.state.rooms.r1.log.filter(line => line.reason === 'cut').length, 0)
})
