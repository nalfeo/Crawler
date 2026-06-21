import{n as b}from"./rolldown-runtime-b3L32Ng1.js";import{$n as S,Dr as P,Et as g,G as T,Ir as x,J as v,K as w,Nn as L,Sn as G,Tr as $,Tt as _,Z as X,q as p}from"./lab-ai-runner-lab-CsVE4zAo.js";import{i as E}from"./lab-combat-lab-BNU6k-pX.js";var V=b({}),I=S("labs:stats");function M(m,l){const a=l.__labGui;if(!(a instanceof E))throw new Error("Lab runner did not initialize lil-gui.");const r=document.createElement("div");r.style.cssText="width:100%;height:100%;overflow:auto;padding:20px;box-sizing:border-box;background:#0d0d14;color:#f0f0f0;font-family:monospace;font-size:13px;",m.append(r);let t,o;function c(){t=L({seed:1337}),o=G(t,0,0),x(t.ecs,o,P),x(t.ecs,o,$),t.playerLevel.unspentPoints=20,p(t),s()}function s(){const n=t.playerLevel,f=g.map(i=>{const h=_[i],y=t.stores.stats[i][o]??0,u=t.stores.statPoints[i][o]??0;return`<tr>
        <td style="padding:4px 12px;color:#9ba">${i}</td>
        <td style="padding:4px 12px;text-align:right;color:#888">${h.toFixed(2)}</td>
        <td style="padding:4px 12px;text-align:right;color:#aef">${u}</td>
        <td style="padding:4px 12px;text-align:right;color:#4f8">${y.toFixed(2)}</td>
      </tr>`}).join("");r.innerHTML=`
      <h2 style="color:#cde;margin:0 0 8px">Stats Lab</h2>
      <p style="color:#888;margin:0 0 16px">Level ${n.level} | XP: ${n.xp} | Unspent: ${n.unspentPoints} pts</p>
      <table style="border-collapse:collapse;width:100%;max-width:600px">
        <thead><tr>
          <th style="text-align:left;padding:4px 12px;color:#aaa">Stat</th>
          <th style="text-align:right;padding:4px 12px;color:#aaa">Base</th>
          <th style="text-align:right;padding:4px 12px;color:#aaa">Points</th>
          <th style="text-align:right;padding:4px 12px;color:#aaa">Final</th>
        </tr></thead>
        <tbody>${f}</tbody>
      </table>
      <p style="color:#666;margin-top:16px;font-size:11px">Use the controls panel to spend points or grant XP.</p>
    `}const e={targetStat:"damage",pointsToSpend:1,xpToGrant:10,modifierValue:5,reset:c};a.add(e,"targetStat",g).name("Stat"),a.add(e,"pointsToSpend",1,20,1).name("Points"),a.add({spendPoints:()=>{try{w(t,{[e.targetStat]:e.pointsToSpend}),p(t),s()}catch(n){I.warn("Cannot spend points in stats lab",{error:n})}}},"spendPoints").name("Spend Points"),a.add(e,"xpToGrant",1,200,1).name("XP to Grant"),a.add({grantXp:()=>{t.playerLevel.xp+=e.xpToGrant,v(t),p(t),s()}},"grantXp").name("Grant XP"),a.add(e,"modifierValue",1,50,1).name("Modifier Value"),a.add({addMod:()=>{T(t,{sourceType:"buff",sourceId:`lab-mod-${Date.now()}`,stat:e.targetStat,op:"add",value:e.modifierValue}),p(t),s()}},"addMod").name("Add Modifier"),a.add(e,"reset").name("Reset World"),c();const d=document.createElement("p");return d.textContent="Inspect how stat points and modifiers interact. Use the GUI to allocate points, grant XP, or add temporary modifiers.",d.style.cssText="margin-top:16px;color:#fbcfe8;line-height:1.6;",l.append(d),()=>{d.remove(),r.remove()}}X("stats-lab",{category:"Progression",name:"Stats Lab",description:"Inspect stat computation: base values, point allocations, and modifier stacking.",create:M});export{V as t};
