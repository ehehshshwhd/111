const auth = require('../../../utils/auth')
const container = require('../../../utils/cloud-container')

function readEventList(response) {
  let payload = response && response.data
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload) } catch (_) { return [] }
  }
  return payload && Array.isArray(payload.events) ? payload.events : []
}

function eventDate(event) {
  if (event.date) return String(event.date)
  const start = String(event.dateStart || '')
  const end = String(event.dateEnd || '')
  if (start && end) return `${start} ~ ${end}`
  return start || end
}

Page({
  data: {
    id: 'suiping',
    // Keep the first render fully defined. WeChat's view layer can fail its
    // initial patch when a large WXML tree reads properties from null.
    event: {
      id: 'suiping', title: '', date: '', status: '', notice: '', dateFull: '', location: '', signup: []
    },
    prizeTables: [], event2PrizeTables: [], event3PrizeTables: [],
    liked: false, likeCount: 0, commentCount: 0, shareCount: 0,
    detailReady: false, interactionBusy: false,
    commentVisible: false, commentText: '', comments: [],
    resultsSheetVisible: false, scoreViewVisible: false, scoreGroups: [], selectedScore: null,
    scoreLoading: true, scoreLoadError: false,
    canAccessWork: false, eventConfigReady: false
  },
  onLoad(query) {
    query = query || {}
    const id = query.id || 'suiping'
    const event = this.makeEvent(id)
    // Keep the first render small. Prize tables are only needed by the long
    // race-detail section, which is currently kept lazy on real devices.
    const event2Labels = ['1、专业组奖金设置', '2、公开组奖金设置', '3、UTV组奖金设置', '4、新秀组奖金设置', '5、女子组奖金设置']
    const event3Labels = ['1、改装组奖金设置', '2、量产组奖金设置']
    this.setData({
      id,
      event,
      prizeTables: [],
      // Keep each section heading attached to its table so the WXML can
      // render the heading immediately before the corresponding table.
      event2PrizeTables: event2Labels.map(label => ({ title: label, headers: [], rows: [], subtotals: [] })),
      event3PrizeTables: event3Labels.map(label => ({ title: label, headers: [], rows: [], subtotals: [] })),
      detailReady: id === 'suiping',
      scoreGroups: [], eventConfigReady: false
    })
    // The long race-detail tree previously mounted in a delayed setData call.
    // On real devices that second large patch can crash WebView rendering
    // (setChanges), leaving only the native navigation bar visible. Keep the
    // detail tree lazy until it is split into smaller sections.
    this._detailTimer = null
    this.loadInteractionStats(id)
    this.loadWorkAccess()
    this.loadPublishedEvent(id)
    this.loadPublishedResults(id)
    if (query.fromShare) this.recordShareOpen(query.fromShare)
  },
  loadPublishedEvent(id) {
    const requestId = (this._eventRequestId || 0) + 1
    this._eventRequestId = requestId
    container.call('/api/public/events').then(readEventList).then(events => {
      if (this.__unloaded || this._eventRequestId !== requestId) return
      const record = events.find(item => String(item && (item.id || item._id) || '') === String(id))
      if (!record) {
        if (String(id) === 'suiping') {
          this.safeSetData({ eventConfigReady: true })
          this.loadWorkAccess()
        }
        return
      }
      const base = this.data.event || {}
      const publishedEvent = {
        ...base,
        id: String(record.id || record._id),
        title: String(record.title || base.title || '赛事详情'),
        date: eventDate(record) || base.date || '',
        dateFull: String(record.dateFull || eventDate(record) || base.dateFull || ''),
        dateStart: String(record.dateStart || ''),
        dateEnd: String(record.dateEnd || ''),
        location: String(record.location || base.location || ''),
        status: String(record.status || base.status || ''),
        notice: String(record.notice || base.notice || ''),
        detailText: String(record.detailText || ''),
        rulesText: String(record.rulesText || ''),
        awardsText: String(record.awardsText || ''),
        registrationDeadline: String(record.registrationDeadline || ''),
        contactName: String(record.contactName || ''),
        contactPhone: String(record.contactPhone || ''),
        contactWechat: String(record.contactWechat || ''),
        registrationNote: String(record.registrationNote || ''),
        signupOptions: Array.isArray(record.signupOptions) ? record.signupOptions : [],
        registrationEnabled: record.registrationEnabled === true,
        workBackendEnabled: record.workBackendEnabled !== false,
        coverFileId: String(record.coverFileId || ''),
        coverUrl: String(record.coverUrl || ''),
        publishedAt: record.publishedAt || null,
        isDynamic: true,
        isGeneric: true
      }
      if (publishedEvent.id === 'suiping') this.safeSetData({ detailReady: false })
      this.safeSetData({ eventConfigReady: true })
      if (!publishedEvent.workBackendEnabled) this.safeSetData({ canAccessWork: false })
      this.resolveEventCover(publishedEvent)
      this.loadWorkAccess()
    }).catch(error => {
      // Keep the bundled legacy event and its existing staff access available when the cloud is offline.
      console.warn('读取赛事详情失败，继续显示内置内容', error)
      if (String(id) === 'suiping') {
        this.safeSetData({ eventConfigReady: true })
        this.loadWorkAccess()
      }
    })
  },
  loadPublishedResults(eventId) {
    const requestId = (this._scoreRequestId || 0) + 1
    this._scoreRequestId = requestId
    const path = '/api/public/results?eventId=' + encodeURIComponent(String(eventId || ''))
    container.call(path).then(response => {
      let payload = response && response.data
      if (typeof payload === 'string') {
        try { payload = JSON.parse(payload) } catch (_) { payload = null }
      }
      if (this.__unloaded || this._scoreRequestId !== requestId) return
      if (!payload || payload.ok !== true || String(payload.eventId || '') !== String(eventId || '')) {
        this.safeSetData({ scoreGroups: [], scoreLoading: false, scoreLoadError: false })
        return
      }
      const stageNames = Array.isArray(payload.stageNames)
        ? payload.stageNames.map(name => String(name || '').trim()).filter(Boolean)
        : []
      const groupNames = Array.isArray(payload.groups)
        ? payload.groups.map(group => String(group && typeof group === 'object' ? group.name || group.group || '' : group || '').trim()).filter(Boolean)
        : []
      const rows = Array.isArray(payload.rows) ? payload.rows : []
      const groups = groupNames.map(name => ({
        name,
        stages: stageNames.filter(stage => rows.some(row => String(row && row.group || '') === name && row.stageTimes && row.stageTimes[stage])).concat(['总成绩']),
        expanded: false
      }))
      this._publishedResults = {
        eventId: String(eventId),
        groups: groupNames,
        stageNames,
        rankingMode: payload.rankingMode === 'total' ? 'total' : 'best',
        rows
      }
      this.safeSetData({ scoreGroups: groups, scoreLoading: false, scoreLoadError: false })
    }).catch(error => {
      if (this.__unloaded || this._scoreRequestId !== requestId) return
      console.warn('读取已发布成绩失败', error)
      this._publishedResults = null
      this.safeSetData({ scoreGroups: [], scoreLoading: false, scoreLoadError: true })
    })
  },
  resolveEventCover(event) {
    if (event.coverUrl || !event.coverFileId || !wx.cloud || typeof wx.cloud.getTempFileURL !== 'function') {
      this.safeSetData({ event })
      return
    }
    wx.cloud.getTempFileURL({ fileList: [event.coverFileId] }).then(response => {
      const file = response && response.fileList && response.fileList[0]
      this.safeSetData({ event: { ...event, coverUrl: file && file.tempFileURL || '' } })
    }).catch(error => {
      console.warn('赛事详情封面加载失败', error)
      this.safeSetData({ event })
    })
  },
  safeSetData(payload, callback) {
    if (this.__unloaded || !this.setData) return
    try {
      this.setData(payload, callback)
    } catch (error) {
      console.warn('赛事详情视图更新失败', error)
    }
  },
  onShow() {
    if (!this.data.event || !this.data.event.id) return
    this.loadWorkAccess()
  },
  hasWorkAccess(user) {
    return !!(user && (user.isStaff || user.isAdmin || user.role === 'staff' || user.role === 'admin' || user.role === 'superadmin'))
  },
  goBack() { wx.navigateBack({ delta: 1 }) },
  showNotice() {
    const notice = String(this.data.event && this.data.event.notice || '').trim()
    if (!notice) return wx.showToast({ title: '暂无赛事公告', icon: 'none' })
    wx.showModal({ title: '赛事公告', content: notice, showCancel: false })
  },
  openResults() {
    wx.setNavigationBarTitle({ title: '成绩详情' })
    this.setData({ resultsSheetVisible: true, scoreViewVisible: false, selectedScore: null })
  },
  closeResults() {
    wx.setNavigationBarTitle({ title: '赛事详情' })
    this.setData({ resultsSheetVisible: false, scoreViewVisible: false, selectedScore: null })
  },
  backToScoreGroups() {
    wx.setNavigationBarTitle({ title: '成绩详情' })
    this.setData({ scoreViewVisible: false, selectedScore: null })
  },
  stopSheetTap() {},
  toggleScoreGroup(event) {
    const index = Number(event.currentTarget.dataset.index)
    const group = this.data.scoreGroups[index]
    if (!group) return
    // Only update the tapped group. Re-sending all groups makes the sheet feel
    // sluggish on lower-end devices.
    this.setData({ ['scoreGroups[' + index + '].expanded']: !group.expanded })
  },
  openScore(event) {
    const groupIndex = Number(event.currentTarget.dataset.groupIndex)
    const stageIndex = Number(event.currentTarget.dataset.stageIndex)
    const group = this.data.scoreGroups[groupIndex]
    if (!group || !group.stages[stageIndex]) return
    const stageName = group.stages[stageIndex]
    const snapshot = this._publishedResults
    const rows = snapshot ? snapshot.rows.filter(row => String(row && row.group || '') === group.name) : []
    const isTotal = stageName === '总成绩'
    const stageNames = isTotal ? group.stages.filter(name => name !== '总成绩') : [stageName]
    const scoreRows = rows.map(row => {
      const stageValues = stageNames.map(name => {
        const stage = row.stageTimes && row.stageTimes[name] || {}
        return {
          name,
          startTime: this.displayScoreValue(stage.startTime),
          endTime: this.displayScoreValue(stage.endTime),
          penalty: this.displayScoreValue(stage.penalty),
          duration: this.displayScoreValue(stage.duration)
        }
      })
      return {
        id: String(row.id || row.carNumber || Math.random()),
        carNumber: String(row.carNumber || ''),
        group: String(row.group || ''),
        rank: row.rank === undefined || row.rank === null ? '' : String(row.rank),
        stageValues,
        validScore: this.displayScoreValue(row.validScore || (snapshot.rankingMode === 'total' ? row.totalScore : row.bestScore)),
        selectedDuration: isTotal ? '' : this.displayScoreValue(row.stageTimes && row.stageTimes[stageName] && row.stageTimes[stageName].duration)
      }
    })
    wx.setNavigationBarTitle({ title: '成绩表' })
    this.setData({
      scoreViewVisible: true,
      selectedScore: {
        groupName: group.name,
        stageName,
        isTotal,
        rankingMode: snapshot && snapshot.rankingMode || 'best',
        rows: scoreRows
      }
    })
  },
  displayScoreValue(value) {
    if (value === undefined || value === null || value === '') return ''
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
    return String(value)
  },
  loadWorkAccess() {
    const cached = auth.getUser()
    // 权限必须以云端最新结果为准，不能用旧缓存先显示工作后台入口。
    this.safeSetData({ canAccessWork: false })
    if (!cached) return
    auth.refreshRole().then(user => {
      if (!this.data.event || !this.data.event.id || !this.data.eventConfigReady) return
      this.safeSetData({ canAccessWork: this.data.event.workBackendEnabled !== false && this.hasWorkAccess(user) })
    }).catch(() => {
      this.safeSetData({ canAccessWork: false })
    })
  },
  openWorkBackend() {
    const user = auth.getUser()
    if (!user) {
      wx.showToast({ title: '请先登录工作人员账户', icon: 'none' })
      return
    }
    auth.refreshRole().then(current => {
      if (this.data.event && this.data.event.workBackendEnabled === false) {
        wx.showToast({ title: '本赛事暂未开放工作后台', icon: 'none' })
        return
      }
      if (!this.hasWorkAccess(current)) {
        this.safeSetData({ canAccessWork: false })
        wx.showToast({ title: '当前账户没有工作权限', icon: 'none' })
        return
      }
      wx.navigateTo({ url: '/pages/work/work?eventId=' + encodeURIComponent(this.data.id) })
    }).catch(() => wx.showToast({ title: '工作权限校验失败，请重试', icon: 'none' }))
  },
  publishMoment() { wx.showToast({ title: '登录后可发布动态', icon: 'none' }) },
  callInteraction(action, data) {
    auth.init()
    if (!wx.cloud) return Promise.reject(new Error('云开发未初始化'))
    return wx.cloud.callFunction({
      name: 'account',
      data: Object.assign({ action, eventId: this.data.id }, data || {})
    }).then(response => {
      const result = response && response.result
      if (!result || !result.ok) throw new Error(result && result.message || '互动服务暂时不可用')
      return result
    })
  },
  applyInteractionStats(result) {
    if (this.__unloaded) return
    const stats = result && result.stats || {}
    this.safeSetData({
      liked: !!stats.liked,
      likeCount: Number(stats.likeCount) || 0,
      commentCount: Number(stats.commentCount) || 0,
      shareCount: Number(stats.shareCount) || 0,
      comments: result.comments || this.data.comments
    })
  },
  loadInteractionStats(eventId) {
    const viewToken = this.__viewToken
    this.callInteraction('getEventStats', { eventId }).then(result => {
      if (this.__unloaded || viewToken !== this.__viewToken) return
      this.applyInteractionStats(result)
    }).catch(error => {
      console.warn('读取赛事互动记录失败', error)
    })
  },
  recordShareOpen(source) {
    const viewToken = this.__viewToken
    this.callInteraction('recordShareOpen', { source }).then(result => {
      if (this.__unloaded || viewToken !== this.__viewToken) return
      this.applyInteractionStats(result)
    }).catch(error => {
      console.warn('记录分享打开失败', error)
    })
  },
  toggleLike() {
    if (this.__unloaded || this._likeBusy) return
    this._likeBusy = true
    const previous = {
      liked: this.data.liked,
      likeCount: this.data.likeCount
    }
    const nextLiked = !previous.liked
    const nextLikeCount = Math.max(0, previous.likeCount + (nextLiked ? 1 : -1))
    // Update the visible state before the network round trip so a slow cloud
    // function does not make the tap appear to be ignored.
    this.safeSetData({ liked: nextLiked, likeCount: nextLikeCount })
    const viewToken = this.__viewToken
    this.callInteraction('toggleLike').then(result => {
      if (this.__unloaded || viewToken !== this.__viewToken) return
      this.applyInteractionStats(result)
      wx.showToast({ title: result.stats.liked ? '已点赞' : '已取消点赞', icon: 'none' })
    }).catch(error => {
      if (!this.__unloaded && viewToken === this.__viewToken) this.safeSetData(previous)
      wx.showToast({ title: error.message || '点赞失败，请重试', icon: 'none' })
    })
      .then(() => { this._likeBusy = false })
  },
  openComments() {
    this.setData({ commentVisible: true })
    this.loadInteractionStats(this.data.id)
  },
  closeComments() {
    this.setData({ commentVisible: false })
  },
  stopCommentTap() {},
  onCommentInput(event) {
    this.setData({ commentText: event.detail.value || '' })
  },
  submitComment() {
    const content = (this.data.commentText || '').trim()
    if (!content) {
      wx.showToast({ title: '请输入评论内容', icon: 'none' })
      return
    }
    const viewToken = this.__viewToken
    this.callInteraction('addComment', { content }).then(result => {
      if (this.__unloaded || viewToken !== this.__viewToken) return
      this.applyInteractionStats(result)
      this.safeSetData({ commentText: '' })
      wx.showToast({ title: '评论已发布', icon: 'none' })
    }).catch(error => wx.showToast({ title: error.message || '评论失败，请重试', icon: 'none' }))
  },
  onShareAppMessage() {
    const event = this.data.event || {}
    return { title: event.title || '赛事详情', path: '/subpackages/events/detail/detail?id=' + (this.data.id || 'suiping') + '&fromShare=message' }
  },
  onShareTimeline() {
    const event = this.data.event || {}
    return { title: event.title || '赛事详情', query: 'id=' + (this.data.id || 'suiping') + '&fromShare=timeline' }
  },
  onUnload() {
    this.__unloaded = true
    this.__viewToken = (this.__viewToken || 0) + 1
    if (this._detailTimer) clearTimeout(this._detailTimer)
  },
  makeEvent(id) {
    const eventInfo = {
      suiping: {
        title: '2026中国·遂平嵖岈山首届汽车越野嘉年华《赛事预报》',
        date: '2026-07-17',
        dateFull: '2026-08-23 ~ 2026-08-30',
        notice: '该赛事有1条公告(点击查看)',
        status: '已完赛',
        location: '河南省-驻马店市-遂平县 （报到地点待定）',
        signup: [
          '集合赛公开A组  ¥ 1/辆（已报0辆）',
          '集合赛公开B组  ¥ 1/辆（已报0辆）',
          '集合赛公开C组  ¥ 1/辆（已报0辆）',
          '集合赛公开D组  ¥ 1/辆（已报0辆）',
          '场地赛专业组  ¥ 1/人（已报0人）',
          '场地赛公开组  ¥ 1/人（已报0人）',
          '场地赛UVT组  ¥ 1/人（已报0人）',
          '场地赛新秀组  ¥ 1/人（已报0人）',
          '场地赛女子组  ¥ 1/人（已报0人）',
          '攀爬赛改装组  ¥ 1/人（已报0人）',
          '攀爬赛量产组  ¥ 1/人（已报0人）'
        ]
      }
    }
    const current = eventInfo[id]
    if (current) return { id, ...current, isGeneric: false, isDynamic: false }
    return {
      id,
      title: '赛事详情',
      date: '',
      dateFull: '',
      notice: '',
      status: '',
      location: '',
      signup: [],
      detailText: '',
      rulesText: '',
      awardsText: '',
      registrationDeadline: '',
      contactName: '',
      contactPhone: '',
      contactWechat: '',
      registrationNote: '',
      signupOptions: [],
      registrationEnabled: false,
      workBackendEnabled: true,
      coverFileId: '',
      coverUrl: '',
      isGeneric: true,
      isDynamic: false
    }
  },
  makeScoreGroups() {
    const stages = ['SS1', 'SS2', 'SS3', 'SS4', 'SS5', 'SS6', 'SS7', 'SS8', 'SS9', '总成绩']
    return ['四驱组', 'N4组', '两驱组', '1.6组', 'POLO杯', '新人组', '“王者归来”组', '巾帼杯', '四驱俱乐部杯', '两驱俱乐部杯', '厂商杯', '飞车王']
      .map(name => ({ name, stages, expanded: false }))
  },
  makePrizeTables() {
    const rows = (values) => values.map((value, index) => [`第${['一','二','三','四','五','六','七','八','九','十'][index]}名`, value])
    const stage = (title, theme, columns, totals) => {
      const max = Math.max.apply(null, columns.map((column) => column.length))
      const tableRows = Array.from({ length: max }, (_, index) => columns.reduce((cells, column) => cells.concat(column[index] || ['--', '--']), []))
      return { title, theme, headers: ['排位赛奖金', '预赛奖金', '决赛奖金'], columns, rows: tableRows, totals, subtotals: totals }
    }
    return [
      {
        order: 4,
        type: 'open-groups',
        title: '坦克汽车（定向集结赛）奖金设置 19.2万元',
        theme: 'blue',
        groups: ['公开A组', '公开B组', '公开C组', '公开D组'],
        rows: [
          ['第一名','20000','第一名','20000','第一名','20000','第一名','20000'],
          ['第二名','10000','第二名','10000','第二名','10000','第二名','10000'],
          ['第三名','5000','第三名','5000','第三名','5000','第三名','5000'],
          ['第四名','4000','第四名','4000','第四名','4000','第四名','4000'],
          ['第五名','3000','第五名','3000','第五名','3000','第五名','3000'],
          ['第六名','2000','第六名','2000','第六名','2000','第六名','2000'],
          ['第七名','1000','第七名','1000','第七名','1000','第七名','1000'],
          ['第八名','1000','第八名','1000','第八名','1000','第八名','1000'],
          ['第九名','1000','第九名','1000','第九名','1000','第九名','1000'],
          ['第十名','1000','第十名','1000','第十名','1000','第十名','1000']
        ],
        subtotals: ['小计：48000元','小计：48000元','小计：48000元','小计：48000元']
      },
      stage('场地越野赛（专业组）奖金设置 11.5万元', 'orange', [rows(['5000','3000','1000']), rows(['10000','5000','4000','3000','2000','1000']), rows(['30000','20000','10000','6000','5000','4000','3000','2000','1000'])], ['小计：9000元','小计：25000元','小计：81000元']),
      stage('场地越野赛（公开组）奖金设置 8.5万元', 'maroon', [rows(['3000','2000','1000']), rows(['6000','5000','4000','3000','2000','1000']), rows(['20000','10000','7000','6000','5000','4000','3000','2000','1000'])], ['小计：6000元','小计：21000元','小计：58000元']),
      stage('场地越野赛（UTV组）奖金设置 8.5万元', 'green', [rows(['3000','2000','1000']), rows(['6000','5000','4000','3000','2000','1000']), rows(['20000','10000','7000','6000','5000','4000','3000','2000','1000'])], ['合计：6000元','合计：21000元','合计：58000元']),
      stage('场地越野赛（新秀组）奖金设置 6.3万元', 'yellow', [rows(['3000','2000','1000']), rows(['6000','5000','4000','3000','2000','1000']), rows(['10000','8000','6000','4000','3000','2000','1000','1000','1000'])], ['合计：6000元','合计：21000元','合计：36000元']),
      stage('场地越野赛（女子组）奖金设置 5.2万元', 'purple', [rows(['3000','2000','1000']), rows(['5000','4000','3000','2000','1000']), rows(['10000','6000','5000','4000','3000','2000','1000'])], ['小计：6000元','小计：15000元','小计：31000元']),
      stage('城市攀爬赛（改装组）奖金设置 8.5万元', 'charcoal', [rows(['3000','2000','1000']), rows(['6000','5000','4000','3000','2000','1000']), rows(['20000','10000','7000','6000','5000','4000','3000','2000','1000'])], ['小计：6000元','小计：21000元','小计：58000元']),
      stage('城市攀爬赛（量产组）奖金设置 6.3万元', 'yellow', [rows(['3000','2000','1000']), rows(['6000','5000','4000','3000','2000','1000']), rows(['10000','8000','6000','4000','3000','2000','1000','1000','1000'])], ['小计：6000元','小计：21000元','小计：36000元'])
    ]
  }
})



