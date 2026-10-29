/** Identity comes only from AstrBot platform instances and explicit routing. Never from persona/profile labels or local filenames. */
export function profileIdentity(profile,platforms=[],routing={}){
 const id=profile.id??profile.uuid;
 const linked=platforms.filter(p=>Object.entries(routing).some(([pattern,target])=>target===id&&pattern===p.id+'::'));
 const instances=(id==='default'?platforms.filter(p=>!Object.keys(routing).some(pattern=>pattern===p.id+'::')):linked).map(p=>({instanceId:p.id,type:p.type,category:p.type==='qq_official'?'QQ机器人':p.type==='aiocqhttp'&&p.id.toLowerCase()==='onebot'?'OneBot':p.type==='aiocqhttp'?'QQ机器人（OneBot）':p.type,status:p.status??'unknown',source:'AstrBot实例接口'}));
 const categories=[...new Set(instances.map(p=>p.category))];
 const name=id==='default'?'全局默认配置':linked.length?categories.join(' / '):'未关联配置 · '+id.slice(0,8);
 return {name,transport:id==='default'?'全局默认':linked.length?categories.join(' / '):'配置档案（非机器人身份）',association:id==='default'?'default':linked.length?'platform-route':'unassigned',instances,account:null,nickname:null,routingStatus:id==='default'?'未命中专用路由的会话使用此配置':linked.length?'已关联平台级路由':'未发现平台级路由；不作为已接入机器人展示'};
}
