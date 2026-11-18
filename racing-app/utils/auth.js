const config=require('../config/cloud')
const {ALL_STAGES}=require('./stages')
function sanitizeUser(value){
  if(!value||!value.id)return null
  const role=['superadmin','admin','staff'].includes(value.role)?value.role:'user'
  const isSuperAdmin=role==='superadmin'
  const isAdmin=isSuperAdmin||role==='admin'
  const allStages=ALL_STAGES
  const rawEntryPermissions=value.entryPermissions&&typeof value.entryPermissions==='object'?value.entryPermissions:{}
  const entryPermissions=isAdmin
    ? {startTime:true,endTime:true,penalty:true}
    : {
      startTime:rawEntryPermissions.startTime!==false,
      endTime:rawEntryPermissions.endTime!==false,
      penalty:rawEntryPermissions.penalty!==false
    }
  const stagePermissions=Array.isArray(value.stagePermissions)
    ? value.stagePermissions.filter(stage=>allStages.includes(stage))
    : allStages
  return {id:value.id,nickname:value.nickname||'赛事用户',avatarUrl:value.avatarUrl||'',loggedIn:true,role,isAdmin,isSuperAdmin,isStaff:isAdmin||role==='staff',stagePermissions,entryPermissions}
}

// 兼容旧版本缓存，同时清掉旧版本可能保存的手机号、openid 等敏感字段。
let user=sanitizeUser(wx.getStorageSync('racing_user'))
if(user)wx.setStorageSync('racing_user',user)
let ready=false
let refreshPromise=null

function init(){
  if(ready)return true
  if(!wx.cloud)return false
  try{
    const options={traceUser:false}
    if(config.env)options.env=config.env
    wx.cloud.init(options)
    ready=true
    return true
  }catch(error){
    console.warn('云开发初始化失败',error)
    return false
  }
}

async function loginWithPhone(code){
  if(!code)throw new Error('未获取到手机号授权凭证')
  if(!init())throw new Error('云开发尚未开启，请在微信开发者工具中选择云开发环境')
  let response
  try{
    response=await wx.cloud.callFunction({
      name:config.accountFunction,
      data:{action:'loginPhone',code}
    })
  }catch(error){
    throw new Error(error&&error.errMsg||'登录服务暂时不可用')
  }
  if(!response||!response.result||!response.result.ok){
    throw new Error(response&&response.result&&response.result.message||'手机号登录失败')
  }
  user=sanitizeUser(response.result.user)
  if(!user)throw new Error('登录服务返回的数据无效')
  wx.setStorageSync('racing_user',user)
  return user
}

function wait(ms){
  return new Promise(resolve=>setTimeout(resolve,ms))
}

async function refreshRole(options){
  if(!user)return null
  if(refreshPromise)return refreshPromise
  refreshPromise=refreshRoleOnce(options)
  try{return await refreshPromise}finally{refreshPromise=null}
}

async function refreshRoleOnce(options){
  if(!init())throw new Error('权限服务暂时不可用')
  const currentUser=user
  const attempts=options&&Number.isInteger(options.retries)?Math.max(1,options.retries):3
  const wasPrivileged=!!(currentUser.isStaff||currentUser.isAdmin)
  let lastError
  for(let attempt=0;attempt<attempts;attempt++){
    try{
      const response=await wx.cloud.callFunction({name:config.accountFunction,data:{action:'getRole'}})
      // 请求期间可能已退出或切换登录，不能用旧请求恢复账号。
      if(user!==currentUser) return user
      if(!response||!response.result||!response.result.ok)throw new Error('权限校验失败')
      const refreshed=sanitizeUser(response.result.user)
      if(!refreshed)throw new Error('权限服务返回的数据无效')
      // 登录后 users 文档可能还在同步。若原缓存已有工作权限而本次暂时返回普通用户，重试几次再决定。
      if(wasPrivileged&&!refreshed.isStaff&&!refreshed.isAdmin&&attempt<attempts-1){
        await wait(220*(attempt+1))
        continue
      }
      user=refreshed
      wx.setStorageSync('racing_user',user)
      return user
    }catch(error){
      lastError=error
      if(attempt<attempts-1)await wait(220*(attempt+1))
    }
  }
  throw lastError||new Error('权限校验失败')
}

function setTab(page,index){
  const bar=page&&page.getTabBar&&page.getTabBar()
  if(bar&&bar.data.selected!==index)bar.setData({selected:index})
}

// 保留给需要登录的业务功能使用；公共页面不会调用它，因此启动时不会强制登录。
function requireLogin(page,index){
  setTab(page,index)
  return !!user
}

function logout(){
  user=null
  wx.removeStorageSync('racing_user')
}

module.exports={init,loginWithPhone,refreshRole,requireLogin,setTab,logout,getUser:()=>user}
