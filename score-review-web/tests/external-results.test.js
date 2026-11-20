'use strict'

const assert = require('node:assert/strict')
const { test, beforeEach } = require('node:test')
const external = require('../external-results')

// 用假的 fetch 代替真实网络，按路径返回预设数据
function fakeFetch(routes) {
  const calls = []
  const impl = async (url) => {
    const path = String(url).replace(external.BASE_URL, '')
    calls.push(path)
    const handler = routes[path]
    if (!handler) return { ok: false, status: 404, json: async () => ({}) }
    const value = typeof handler === 'function' ? handler() : handler
    if (value && value.throw) throw value.throw
    return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(value)) }
  }
  impl.calls = calls
  return impl
}

const detail = {
  event: { id: 'evt1', name: '2026资兴汽车拉力赛（测试用）' },
  categories: [
    { id: 'catA', name: '四驱组' },
    { id: 'catB', name: '两驱组' }
  ],
  stages: [
    { id: 's1', code: 'SS1', published_version: 3, sort: 1 },
    { id: 's2', code: 'SS2', published_version: 0, sort: 2 },
    { id: 's3', code: 'SS10', published_version: 1, sort: 10 }
  ]
}

function stageRows() {
  return {
    published: true,
    rows: [
      { bib: '1', categories: ['catA'], time_ms: 90000, penalty_ms: 0, total_ms: 90000, rank: 1, category_ranks: { catA: 1 } },
      { bib: '2', categories: ['catA', 'catB'], time_ms: 95000, penalty_ms: 10000, total_ms: 105000, rank: 2, category_ranks: { catA: 2, catB: 1 } },
      { bib: '', categories: ['catA'], total_ms: 1 }
    ]
  }
}

beforeEach(() => external.clearCache())

test('event names match regardless of spaces, case and parenthesised suffixes', () => {
  assert.equal(
    external.normalizeEventName('2026资兴汽车拉力赛（测试用）'),
    external.normalizeEventName('2026 资兴汽车拉力赛')
  )
  assert.equal(external.normalizeEventName('Rally A'), external.normalizeEventName('rallya'))
  assert.notEqual(external.normalizeEventName('拉力赛A'), external.normalizeEventName('拉力赛B'))
})

test('fuzzy match links a promotional title to the website event name', () => {
  const score = (a, b) => external.eventNameSimilarity(a, b)
  assert.equal(score('2026湖南资兴汽车拉力赛重磅来袭！', '2026资兴汽车拉力赛（测试用）'), 1)
  assert.ok(score('资兴拉力赛', '2026资兴汽车拉力赛') >= 0.8)
  // 不同地方、不同年份、完全不同的比赛都不能对上
  assert.ok(score('2026资兴汽车拉力赛', '2026郴州汽车拉力赛') < 0.8)
  assert.equal(score('2025资兴汽车拉力赛', '2026资兴汽车拉力赛'), 0)
  assert.equal(score('2026湖南资兴汽车拉力赛重磅来袭！', '大屏演示'), 0)
  assert.ok(score('2026林西大河英雄会', '2026大别山越野英雄会') < 0.8)
  assert.equal(score('拉力', '2026资兴汽车拉力赛'), 0, 'names that are too short never fuzzy match')
})

test('fuzzy lookup picks the closest event and refuses ties', async () => {
  const fetchImpl = fakeFetch({
    '/events': { items: [
      { id: '9wonler9d6vz7le', name: '2026资兴汽车拉力赛（测试用）' },
      { id: '75siap6bhb9nxvc', name: '大屏演示' }
    ] }
  })
  const hit = await external.findExternalEvent('2026湖南资兴汽车拉力赛重磅来袭！', fetchImpl)
  assert.equal(hit && hit.id, '9wonler9d6vz7le')

  external.clearCache()
  const tie = fakeFetch({
    '/events': { items: [{ id: 'a', name: '资兴汽车拉力赛' }, { id: 'b', name: '资兴汽车拉力赛总决赛' }] }
  })
  assert.equal(await external.findExternalEvent('2026资兴汽车拉力赛', tie), null, 'two equally close events are not guessed')

  external.clearCache()
  const exactWins = fakeFetch({
    '/events': { items: [{ id: 'exact', name: '资兴拉力赛' }, { id: 'near', name: '资兴汽车拉力赛' }] }
  })
  assert.equal((await external.findExternalEvent('资兴拉力赛', exactWins)).id, 'exact', 'an exact name always wins over a fuzzy one')
})

test('durations and penalties are formatted for the mini-program', () => {
  assert.equal(external.formatDurationMs(98530), '1:38.530')
  assert.equal(external.formatDurationMs(60000), '1:00.000')
  assert.equal(external.formatDurationMs(3723456), '1:02:03.456')
  assert.equal(external.formatDurationMs(0), '0:00.000')
  assert.equal(external.formatDurationMs(undefined), '0:00.000')
})

test('a unique name match is used, duplicates or misses are refused', async () => {
  const fetchImpl = fakeFetch({
    '/events': { events: [{ id: 'evt1', name: '拉力赛（测试用）' }, { id: 'evt2', name: '另一场比赛' }] }
  })
  const hit = await external.findExternalEvent('拉力赛', fetchImpl)
  assert.equal(hit.id, 'evt1')
  assert.equal(await external.findExternalEvent('不存在的比赛', fetchImpl), null)

  external.clearCache()
  const ambiguous = fakeFetch({
    '/events': { events: [{ id: 'a', name: '拉力赛' }, { id: 'b', name: '拉力赛 ' }] }
  })
  assert.equal(await external.findExternalEvent('拉力赛', ambiguous), null, '重名时不猜')
})

test('snapshot keeps only published stages and splits multi-category cars per group', async () => {
  const fetchImpl = fakeFetch({
    '/events/evt1': detail,
    '/events/evt1/stages/s1': stageRows(),
    '/events/evt1/stages/s3': {
      published: true,
      rows: [{ bib: '1', categories: ['catA'], time_ms: 61000, penalty_ms: 0, total_ms: 61000, rank: 1, category_ranks: { catA: 1 } }]
    },
    '/events/evt1/overall': {
      published: true,
      rows: [
        { bib: '1', categories: ['catA'], total_ms: 151000, rank: 1, category_ranks: { catA: 1 } },
        { bib: '2', categories: ['catA', 'catB'], total_ms: 166000, rank: 2, category_ranks: { catA: 2, catB: 1 } }
      ]
    }
  })
  const snapshot = await external.buildSnapshot('event-x', 'evt1', fetchImpl)

  assert.equal(snapshot.eventId, 'event-x')
  assert.equal(snapshot.source, 'xinjinho')
  assert.deepEqual(snapshot.stageNames, ['SS1', 'SS10'], 'unpublished SS2 is dropped, stages sort numerically')
  assert.deepEqual(snapshot.groups.sort(), ['四驱组', '两驱组'].sort())
  assert.equal(snapshot.rowCount, snapshot.rows.length)

  const car1 = snapshot.rows.find(row => row.group === '四驱组' && row.carNumber === '1')
  assert.equal(car1.stageTimes.SS1.duration, '1:30.000')
  assert.equal(car1.stageTimes.SS1.penalty, '')
  assert.equal(car1.rank, 1)
  assert.equal(car1.validScore, '2:31.000', 'total comes from the overall snapshot')

  const car2Four = snapshot.rows.find(row => row.group === '四驱组' && row.carNumber === '2')
  const car2Two = snapshot.rows.find(row => row.group === '两驱组' && row.carNumber === '2')
  assert.ok(car2Four && car2Two, 'a car entered in two categories appears in both groups')
  assert.equal(car2Four.stageTimes.SS1.penalty, '0:10.000', 'penalty keeps minutes:seconds.milliseconds')
  assert.equal(car2Four.stageTimes.SS1.duration, '1:45.000')
  assert.equal(car2Four.rank, 2)
  assert.equal(car2Two.rank, 1, 'rank follows the category, not the overall list')
  assert.deepEqual(snapshot.groupStageNames['四驱组'].sort(), ['SS1', 'SS10'].sort())
})

test('overall rows without category ranks are ranked inside each group', async () => {
  // 真实接口的总成绩行只有全场 rank，没有 category_ranks；组别名次必须按组内用时重新排
  const fetchImpl = fakeFetch({
    '/events/evt1': detail,
    '/events/evt1/stages/s1': {
      published: true,
      rows: [
        { bib: '1', categories: ['catA'], time_ms: 90000, penalty_ms: 0, total_ms: 90000, rank: 2, category_ranks: { catA: 1 } },
        { bib: '2', categories: ['catA'], time_ms: 95000, penalty_ms: 0, total_ms: 95000, rank: 3, category_ranks: { catA: 2 } },
        { bib: '3', categories: ['catB'], time_ms: 88000, penalty_ms: 0, total_ms: 88000, rank: 1, category_ranks: { catB: 1 } },
        { bib: '4', categories: ['catB'], time_ms: 99000, penalty_ms: 0, total_ms: 99000, rank: 4, category_ranks: { catB: 2 } }
      ]
    },
    '/events/evt1/stages/s3': { published: true, rows: [] },
    '/events/evt1/overall': {
      published: true,
      rows: [
        { bib: '1', categories: ['catA'], total_ms: 90000, rank: 2 },
        { bib: '2', categories: ['catA'], total_ms: 95000, rank: 3 },
        { bib: '3', categories: ['catB'], total_ms: 88000, rank: 1 },
        { bib: '4', categories: ['catB'], total_ms: 99000, rank: 4 }
      ]
    }
  })
  const snapshot = await external.buildSnapshot('event-x', 'evt1', fetchImpl)
  const find = (group, carNumber) => snapshot.rows.find(row => row.group === group && row.carNumber === carNumber)

  assert.equal(find('四驱组', '1').rank, 1, 'the first car of the group is rank 1, not its overall rank')
  assert.equal(find('四驱组', '2').rank, 2)
  assert.equal(find('两驱组', '3').rank, 1)
  assert.equal(find('两驱组', '4').rank, 2)
  assert.equal(find('四驱组', '1').stageRanks.SS1, 1, 'stage ranks are kept per group')
  assert.equal(find('两驱组', '3').stageRanks.SS1, 1)
})

test('without an overall snapshot ranks come from the stage rows', async () => {
  const fetchImpl = fakeFetch({
    '/events/evt1': detail,
    '/events/evt1/stages/s1': stageRows(),
    '/events/evt1/stages/s3': { published: true, rows: [] },
    '/events/evt1/overall': { throw: new Error('overall down') }
  })
  const snapshot = await external.buildSnapshot('event-x', 'evt1', fetchImpl)
  const car1 = snapshot.rows.find(row => row.carNumber === '1' && row.group === '四驱组')
  const car2 = snapshot.rows.find(row => row.carNumber === '2' && row.group === '四驱组')
  assert.equal(car1.rank, 1)
  assert.equal(car2.rank, 2)
  assert.equal(car2.validScore, '1:45.000')
})

test('no published stage produces no snapshot, so the caller falls back', async () => {
  const fetchImpl = fakeFetch({
    '/events': { events: [{ id: 'evt1', name: '拉力赛' }] },
    '/events/evt1': { categories: [], stages: [{ id: 's1', code: 'SS1', published_version: 0 }] }
  })
  assert.equal(await external.getExternalResults('event-x', '拉力赛', fetchImpl), null)
})

test('network failure falls back instead of throwing', async () => {
  const fetchImpl = fakeFetch({ '/events': { throw: new Error('boom') } })
  const original = console.warn
  console.warn = () => {}
  try {
    assert.equal(await external.getExternalResults('event-x', '拉力赛', fetchImpl), null)
  } finally {
    console.warn = original
  }
})

test('results are cached briefly and refetched after the cache is cleared', async () => {
  const fetchImpl = fakeFetch({
    '/events': { events: [{ id: 'evt1', name: '拉力赛' }] },
    '/events/evt1': detail,
    '/events/evt1/stages/s1': stageRows(),
    '/events/evt1/stages/s3': { published: true, rows: [] },
    '/events/evt1/overall': { published: true, rows: [] }
  })
  const first = await external.getExternalResults('event-x', '拉力赛', fetchImpl)
  const callsAfterFirst = fetchImpl.calls.length
  const second = await external.getExternalResults('event-x', '拉力赛', fetchImpl)
  assert.equal(second, first, 'second read is served from cache')
  assert.equal(fetchImpl.calls.length, callsAfterFirst)

  external.clearCache()
  await external.getExternalResults('event-x', '拉力赛', fetchImpl)
  assert.ok(fetchImpl.calls.length > callsAfterFirst, 'after clearing, the website is read again')
})
