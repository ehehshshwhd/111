const auth=require('../../utils/auth')
Page({
  data:{loading:false,error:'',agreed:false},
  fromProfile:false,
  onLoad(options){this.fromProfile=options&&options.from==='profile'},
  onShow(){if(auth.getUser()&&this.fromProfile)wx.navigateBack({delta:1})},
  toggleAgree(){this.setData({agreed:!this.data.agreed,error:''})},
  openAgreement(e){const type=e&&e.currentTarget&&e.currentTarget.dataset.type==='user'?'user':'privacy';wx.navigateTo({url:'/pages/agreement/agreement?type='+type})},
  onGetPhoneNumber(e){
    if(this.data.loading)return
    if(!this.data.agreed){this.setData({error:'请先阅读并勾选同意《用户服务协议》和《隐私政策》'});return}
    const code=e&&e.detail&&e.detail.code
    if(!code){this.setData({error:'你取消了手机号授权'});return}
    this.setData({loading:true,error:''})
    auth.loginWithPhone(code).then(()=>{
      if(this.fromProfile)wx.navigateBack({delta:1})
      else wx.switchTab({url:'/pages/profile/profile'})
    }).catch(error=>this.setData({error:error&&error.message||'手机号快捷登录失败，请重试'})).then(()=>this.setData({loading:false}))
  },
  cancel(){if(getCurrentPages().length>1)wx.navigateBack({delta:1});else wx.switchTab({url:'/pages/events/events'})}
})
