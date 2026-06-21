import{n as y}from"./rolldown-runtime-b3L32Ng1.js";import{$ as b,$n as T,Lr as u,Q as C,Z as E,n as S,r as $}from"./lab-ai-runner-lab-CEtLjSZs.js";var L=y({}),m=T("lab:bt-viz");function h(n,a,t){n.innerHTML="";const i=document.createElement("div");i.style.cssText="padding: 10px; background: #222; border-bottom: 1px solid #444;",i.innerHTML='<h3 style="margin:0; color: #fff;">Behavior Tree Visualization</h3>',n.appendChild(i);const c=document.createElement("div");c.style.cssText="padding: 10px; background: #333; border-bottom: 1px solid #444;",c.innerHTML=`
    <div style="color: #fff; font-weight: bold;">Current State: <span style="color: #4fc3f7;">${["EXPLORE","ENGAGE","RETREAT","COLLECT","INTERACT"][t.state]||"UNKNOWN"}</span></div>
    <div style="color: #aaa; font-size: 12px; margin-top: 4px;">Reason: ${t.reason}</div>
    ${t.targetX!==null?`<div style="color: #aaa; font-size: 12px;">Target: (${Math.round(t.targetX)}, ${Math.round(t.targetY||0)})</div>`:""}
  `,n.appendChild(c);const l=document.createElement("div");l.style.cssText="padding: 10px; overflow-y: auto; max-height: 500px; background: #1e1e1e;",n.appendChild(l);function d(e,r,p){const f=document.createElement("div");f.style.cssText=`
      margin-left: ${r*20}px;
      padding: 4px 8px;
      margin-top: 4px;
      border-left: 2px solid ${o(e.type)};
      background: ${r%2===0?"#2a2a2a":"#252525"};
      font-family: monospace;
      font-size: 12px;
      color: #fff;
    `;const v=document.createElement("span");v.style.cssText=`color: ${o(e.type)}; font-weight: bold;`,v.textContent=`[${e.type}] `;const g=document.createElement("span");if(g.style.cssText="color: #ddd;",g.textContent=e.name,f.appendChild(v),f.appendChild(g),p.appendChild(f),e.children&&e.children.length>0)for(const x of e.children)d(x,r+1,p)}function o(e){switch(e){case"Sequence":return"#4caf50";case"Selector":return"#ff9800";case"Condition":return"#2196f3";case"Action":return"#f44336";case"Inverter":case"Succeeder":case"Repeat":return"#9c27b0";default:return"#888"}}d(a,0,l);const s=document.createElement("div");s.style.cssText="padding: 10px; background: #222; border-top: 1px solid #444; font-size: 11px;",s.innerHTML=`
    <div style="color: #fff; font-weight: bold; margin-bottom: 6px;">Legend:</div>
    <div style="color: ${o("Sequence")};">■ Sequence - Execute children in order (AND)</div>
    <div style="color: ${o("Selector")};">■ Selector - Try children until one succeeds (OR)</div>
    <div style="color: ${o("Condition")};">■ Condition - Test a boolean condition</div>
    <div style="color: ${o("Action")};">■ Action - Execute a behavior</div>
    <div style="color: ${o("Inverter")};">■ Decorator - Modify child behavior</div>
  `,n.appendChild(s)}E("bt-viz",{name:"Behavior Tree Visualization",description:"Visualize and debug AI behavior trees in real-time",create:(n,a)=>{m.info("Starting Behavior Tree Visualization Lab");const t=new S({seed:54321,debug:!0});a.style.cssText=`
      background: #1e1e1e;
      color: #fff;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      overflow-y: auto;
    `;const i={poll(e){const r=d.scene.getScene("MainGameScene");if(r&&r.world){const p=r.world;t.poll(e,p)}else e.moveX=0,e.moveY=0,e.action=!1,e.pointerX=0,e.pointerY=0},destroy(){}},c={...$(),inputCaptureOverride:i},l={type:u.WEBGL,parent:n,width:1280,height:720,backgroundColor:"#1a1a2e",pixelArt:!0,scene:[C,new b(c)],scale:{mode:u.Scale.FIT,autoCenter:u.Scale.CENTER_BOTH},physics:{default:"arcade",arcade:{gravity:{x:0,y:0},debug:!1}}},d=new u.Game(l);h(a,t.getTree().serialize(),t.getDecision());let o=0;const s=setInterval(()=>{o++,o%10===0&&h(a,t.getTree().serialize(),t.getDecision())},16);return()=>{clearInterval(s),d.destroy(!0),m.info("Behavior Tree Visualization Lab stopped")}}});export{L as t};
