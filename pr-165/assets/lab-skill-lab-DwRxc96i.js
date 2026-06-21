import{n as C}from"./rolldown-runtime-b3L32Ng1.js";import{B as I,Dr as P,H as M,I as _,Ir as $,L as A,Nn as q,R as L,Sn as U,Tr as z,U as G,V as K,W as j,Z as R,q as b,z as D}from"./lab-ai-runner-lab-xGpWycUL.js";import{i as F}from"./lab-combat-lab-DxLFQcJ8.js";var V=C({});function H(T,k){const a=k.__labGui;if(!(a instanceof F))throw new Error("Lab runner did not initialize lil-gui.");const g=document.createElement("div");g.style.cssText="width:100%;height:100%;overflow:auto;padding:20px;box-sizing:border-box;background:#0d0d14;color:#f0f0f0;font-family:monospace;font-size:13px;",T.append(g);const r=j(),m=G(),v=m.filter(t=>t.kind!=="passive"),f=m.filter(t=>t.kind==="passive");let e,s=-1;function S(){e=q({seed:777}),s=U(e,0,0),$(e.ecs,s,P),$(e.ecs,s,z),b(e);const t=new Map;for(const l of r){const p={level:0,usage:0,itemBonus:0,triggeredMilestones:new Set};e.playerSkills.set(l.id,p),t.set(l.id,p)}e.skillStatesByEntity.set(s,t),e.abilityStatesByEntity.set(s,D(e,s)),d()}function d(){const t=e.abilityStatesByEntity.get(s),l=t?.equippedActiveAbilityIds??[],p=t?.passiveAbilityIds??[],B=r.map(n=>{const o=e.playerSkills.get(n.id);if(!o)return"";const c=Math.min(15+o.itemBonus,20),y=o.level<c?n.usageThresholds[o.level]??"—":"Maxed",h=n.milestones.map(u=>{const w=o.triggeredMilestones.has(u.level);return`<span style="color:${w?"#4f8":"#555"};margin-right:4px">${u.level}${w?"✓":"○"}</span>`}).join("");return`
        <tr>
          <td style="padding:5px 10px;color:#9ba">${n.name}</td>
          <td style="padding:5px 10px;text-align:center;color:#aef">${o.level}/${c}</td>
          <td style="padding:5px 10px;text-align:right;color:#888">${o.usage}</td>
          <td style="padding:5px 10px;text-align:right;color:#888">${y}</td>
          <td style="padding:5px 10px">${h}</td>
        </tr>`}).join(""),E=m.map(n=>{const o=l.includes(n.id),c=p.includes(n.id),y=t?.cooldownByAbilityId.get(n.id),h=y===void 0||n.kind==="passive"?void 0:Math.max(0,n.cooldownFrames-(e.frameCount-y)),u=h===void 0?"—":`${h}`;return`
        <tr>
          <td style="padding:5px 10px;color:#9ba">${n.name}</td>
          <td style="padding:5px 10px;color:#8ab">${n.kind}</td>
          <td style="padding:5px 10px;color:${o||c?"#4f8":"#666"}">${o||c?"yes":"no"}</td>
          <td style="padding:5px 10px;text-align:right;color:#888">${u}</td>
        </tr>`}).join("");g.innerHTML=`
      <h2 style="color:#cde;margin:0 0 8px">Skill + Ability Lab</h2>
      <p style="margin:0 0 12px;color:#89a">Active slots: ${l.length}/10 • Passive grants: ${p.length}</p>
      <h3 style="margin:10px 0 6px;color:#bcd">Skill Catalog</h3>
      <table style="border-collapse:collapse;width:100%;max-width:860px;margin-bottom:14px">
        <thead><tr>
          <th style="text-align:left;padding:5px 10px;color:#aaa">Skill</th>
          <th style="padding:5px 10px;color:#aaa">Level</th>
          <th style="text-align:right;padding:5px 10px;color:#aaa">Usage</th>
          <th style="text-align:right;padding:5px 10px;color:#aaa">Next Threshold</th>
          <th style="padding:5px 10px;color:#aaa">Milestones</th>
        </tr></thead>
        <tbody>${B}</tbody>
      </table>
      <h3 style="margin:10px 0 6px;color:#bcd">Ability Catalog</h3>
      <table style="border-collapse:collapse;width:100%;max-width:860px">
        <thead><tr>
          <th style="text-align:left;padding:5px 10px;color:#aaa">Ability</th>
          <th style="padding:5px 10px;color:#aaa">Kind</th>
          <th style="padding:5px 10px;color:#aaa">Enabled</th>
          <th style="text-align:right;padding:5px 10px;color:#aaa">Cooldown</th>
        </tr></thead>
        <tbody>${E}</tbody>
      </table>
    `}const i={selectedSkill:r[0].id,metric:r[0].usageMetric,usageAmount:10,itemBonus:0,selectedActiveAbility:v[0]?.id??"",selectedPassiveAbility:f[0]?.id??"",selectedTriggerKind:"skill_usage",reset:S};a.add(i,"selectedSkill",r.map(t=>t.id)).name("Skill").onChange(t=>{i.metric=r.find(l=>l.id===t)?.usageMetric??"hits_landed",d()}),a.add(i,"usageAmount",1,500,1).name("Usage Amount"),a.add({fireUsage:()=>{e.skillUsageEvents.push({holderEid:s,skillId:i.selectedSkill,metric:i.metric,amount:i.usageAmount}),e.frameCount+=1,_(e),A(e),b(e),d()}},"fireUsage").name("Fire Usage Event"),a.add(i,"itemBonus",0,5,1).name("Item Bonus").onChange(t=>{const l=e.playerSkills.get(i.selectedSkill);l&&(l.itemBonus=t),d()}),v.length>0&&(a.add(i,"selectedActiveAbility",v.map(t=>t.id)).name("Active/Spell"),a.add({equipActive:()=>{const t=m.find(l=>l.id===i.selectedActiveAbility);t&&(t.kind==="spell"?K(e,s,t.id):L(e,s,t.id),d())}},"equipActive").name("Equip Active/Spell")),f.length>0&&(a.add(i,"selectedPassiveAbility",f.map(t=>t.id)).name("Passive"),a.add({grantPassive:()=>{I(e,s,i.selectedPassiveAbility),A(e),b(e),d()}},"grantPassive").name("Grant Passive")),a.add(i,"selectedTriggerKind",["skill_usage"]).name("Trigger Kind"),a.add({fireTrigger:()=>{M(e,{holderEid:s,kind:i.selectedTriggerKind,metric:i.metric,skillId:i.selectedSkill,amount:i.usageAmount}),e.frameCount+=1,A(e),b(e),d()}},"fireTrigger").name("Fire Ability Trigger"),a.add(i,"reset").name("Reset World"),S();const x=document.createElement("p");return x.textContent="Catalog sandbox for skills and abilities — test usage progression, active slot limits, passive grants, and trigger cooldowns.",x.style.cssText="padding:8px 16px;color:#fbcfe8;font-family:monospace;font-size:12px;background:#0d0d14;",k.append(x),()=>{g.remove(),x.remove()}}R("skill-lab",{category:"Progression",name:"Skill Lab",description:"Browse the skill and ability catalogs, simulate usage events, and inspect active/passive/cooldown behavior.",create:H});export{V as t};
