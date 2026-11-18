const auth=require('../../utils/auth')
Page({
  data:{user:{nickname:'赛事用户',avatarUrl:''},loggedIn:false,showLoginSheet:false,loading:false,error:'',agreed:false},
  onShow(){
    const user=auth.getUser()
    // 先用本地缓存立即渲染，不等云端请求
    this.setData({user:user||{nickname:'赛事用户',avatarUrl:''},loggedIn:!!user,showLoginSheet:!user,error:'',agreed:false})
    const bar=this.getTabBar&&this.getTabBar()
    if(bar)bar.setData({selected:2})
    // refreshRole 在后台静默更新，不阻塞页面显示
    if(user){
      const now=Date.now()
      const age=now-(this._roleRefreshedAt||0)
      if(age>60000){
        // 距上次刷新超过 1 分钟才发请求
        this._roleRefreshedAt=now
        auth.refreshRole().then(current=>{if(current)this.setData({user:current,loggedIn:!!current})}).catch(()=>{})
      }
    }
  },
  onProfileTap(){if(this.data.loggedIn)wx.showToast({title:'已登录',icon:'none'});else this.setData({showLoginSheet:true})},
  noop(){},
  closeLoginSheet(){this.setData({showLoginSheet:false,error:''})},
  toggleAgree(){this.setData({agreed:!this.data.agreed,error:''})},
  openAgreement(e){const type=e&&e.currentTarget&&e.currentTarget.dataset.type==='user'?'user':'privacy';wx.navigateTo({url:'/pages/agreement/agreement?type='+type})},
  getPhoneNumber(e){
    if(!this.data.agreed){this.setData({error:'请先阅读并勾选同意《用户服务协议》和《隐私政策》'});return}
    const code=e&&e.detail&&e.detail.code
    if(!code){this.setData({error:'你取消了手机号授权'});return}
    this.setData({loading:true,error:''})
    auth.loginWithPhone(code).then(user=>this.setData({user,loggedIn:true,showLoginSheet:false})).catch(error=>this.setData({error:error&&error.message||'手机号登录失败，请重试'})).then(()=>this.setData({loading:false}))
  },
  openAdmin(){if(!this.data.user||!this.data.user.isAdmin){wx.showToast({title:'无管理员权限',icon:'none'});return}wx.navigateTo({url:'/pages/admin/admin'})},
  openMenu(e){if(!this.data.loggedIn){this.setData({showLoginSheet:true});return}wx.showToast({title:e.currentTarget.dataset.label+'功能待开通',icon:'none'})},
  logout(){auth.logout();this.setData({user:{nickname:'赛事用户',avatarUrl:''},loggedIn:false,showLoginSheet:false});wx.showToast({title:'已退出登录',icon:'none'})}
})
