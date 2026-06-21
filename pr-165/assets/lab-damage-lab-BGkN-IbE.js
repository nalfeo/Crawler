import{n as qe}from"./rolldown-runtime-b3L32Ng1.js";import{Z as Ke}from"./lab-ai-runner-lab-xGpWycUL.js";var ga=qe({}),Ze="#0d0d14",Qe="rgba(22, 33, 62, 0.9)",ea="rgba(255, 255, 255, 0.12)",ge="#e0e0e0",pe="#c9d4ff",w="#7ee0ff",aa="#45567d",ta="#ff5f5f",na=24,ia=16,be=100,_e=4,Ge=12,la=4,oa=180,he=80,ra=120,R=28,ue=28;function Oe(s,p,b){return Math.min(b,Math.max(p,s))}function P(s,p){return Math.max(1,s-p)}function fe(s,p,b,c,m){const d=P(s,p),a=Math.min(c+1,m);return d*b*a}function D(s,p=0){return s.toFixed(p)}function ve(s){const p=Math.max(1,Math.floor(s.clientWidth)),b=Math.max(1,Math.floor(s.clientHeight)),c=Math.max(1,window.devicePixelRatio||1),m=Math.max(1,Math.floor(p*c)),d=Math.max(1,Math.floor(b*c));if(s.width===m&&s.height===d)return!1;s.width=m,s.height=d;const a=s.getContext("2d");return a&&(a.setTransform(1,0,0,1,0,0),a.scale(c,c)),!0}function sa(s){return s>.5?"#22c55e":s>=.25?"#facc15":"#ef4444"}function ca(s,p){const b=p.__labGui;if(!b)throw new Error("Lab runner did not initialize lil-gui.");const c={incomingDamage:25,armor:5},m={invincibilityMs:250,contactDamage:5},d={pierceCount:1,enemyCount:5,projectileDamage:10},a={damagePerHit:10,fireRate:3,pierce:1,targetArmor:0};let M=be,y=-1/0,F=0,L=performance.now();const Ye=L;let xe=!1,o=null,S=["Press Fire to simulate projectile pierce through the lane."];const k=document.createElement("style");k.textContent=`
    .damage-lab {
      min-height: 100%;
      padding: ${na}px;
      box-sizing: border-box;
      background: ${Ze};
      color: ${ge};
      font-family: monospace;
      overflow: auto;
    }
    .damage-lab__grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      grid-template-rows: repeat(2, minmax(260px, auto));
      gap: 16px;
      min-height: 100%;
    }
    .damage-lab__card {
      display: flex;
      flex-direction: column;
      gap: 12px;
      min-height: 0;
      padding: ${ia}px;
      border-radius: 16px;
      border: 1px solid ${ea};
      background: ${Qe};
      box-sizing: border-box;
      box-shadow: 0 14px 32px rgba(0, 0, 0, 0.24);
    }
    .damage-lab__card h3 {
      margin: 0;
      color: ${w};
      font-size: 18px;
      font-weight: 700;
    }
    .damage-lab__subtle {
      color: ${pe};
      font-size: 12px;
      line-height: 1.5;
    }
    .damage-lab__formula,
    .damage-lab__stats,
    .damage-lab__log,
    .damage-lab__status {
      border-radius: 12px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(5, 10, 24, 0.45);
      padding: 12px;
      line-height: 1.6;
    }
    .damage-lab__formula-row,
    .damage-lab__stat-row {
      display: flex;
      justify-content: space-between;
      gap: 12px;
    }
    .damage-lab__label {
      color: ${pe};
    }
    .damage-lab__value {
      color: ${w};
      font-weight: 700;
    }
    .damage-lab__player {
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 14px;
      border-radius: 12px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(5, 10, 24, 0.42);
    }
    .damage-lab__health-shell,
    .damage-lab__cooldown-shell {
      position: relative;
      overflow: hidden;
      border-radius: 999px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      background: rgba(88, 96, 120, 0.28);
    }
    .damage-lab__health-shell {
      height: 22px;
    }
    .damage-lab__health-fill,
    .damage-lab__cooldown-fill {
      height: 100%;
      width: 100%;
      border-radius: inherit;
      transition: width 180ms ease, background-color 180ms ease;
    }
    .damage-lab__health-text {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #05101f;
      font-size: 12px;
      font-weight: 700;
      text-shadow: none;
    }
    .damage-lab__cooldown-shell {
      height: 12px;
    }
    .damage-lab__actions {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    .damage-lab__button {
      border: 1px solid rgba(126, 224, 255, 0.28);
      border-radius: 10px;
      padding: 10px 14px;
      background: rgba(10, 24, 40, 0.88);
      color: ${ge};
      font-family: monospace;
      cursor: pointer;
      transition: transform 120ms ease, border-color 120ms ease, background 120ms ease;
    }
    .damage-lab__button:hover {
      transform: translateY(-1px);
      border-color: rgba(126, 224, 255, 0.6);
      background: rgba(17, 47, 71, 0.94);
    }
    .damage-lab__button:active {
      transform: translateY(0);
    }
    .damage-lab__canvas-wrap {
      border-radius: 12px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(5, 10, 24, 0.42);
      padding: 10px;
    }
    .damage-lab__pierce-canvas {
      display: block;
      width: 100%;
      height: ${he}px;
    }
    .damage-lab__chart {
      display: block;
      width: 100%;
      height: ${ra}px;
    }
    .damage-lab__log {
      min-height: 110px;
      max-height: 140px;
      overflow: auto;
      white-space: pre-line;
    }
  `;const A=document.createElement("div");A.className="damage-lab";const I=document.createElement("div");I.className="damage-lab__grid",A.append(I);const j=document.createElement("section");j.className="damage-lab__card";const ye=document.createElement("h3");ye.textContent="Damage Calculator";const W=document.createElement("div");W.className="damage-lab__subtle",W.textContent="Live visualization of armor mitigation: effectiveDamage = max(1, incoming - armor).";const B=document.createElement("div");B.className="damage-lab__formula",j.append(ye,W,B);const G=document.createElement("section");G.className="damage-lab__card";const Ce=document.createElement("h3");Ce.textContent="Invincibility Frame Tester";const O=document.createElement("div");O.className="damage-lab__subtle",O.textContent="Contact hits respect armor and block re-hits until invincibility expires.";const Y=document.createElement("div");Y.className="damage-lab__player";const Ee=document.createElement("div");Ee.innerHTML='<span class="damage-lab__label">Entity:</span> <span class="damage-lab__value">Player</span>';const z=document.createElement("div");z.className="damage-lab__health-shell";const N=document.createElement("div");N.className="damage-lab__health-fill";const X=document.createElement("div");X.className="damage-lab__health-text",z.append(N,X);const U=document.createElement("div");U.className="damage-lab__status";const J=document.createElement("div");J.className="damage-lab__cooldown-shell";const $=document.createElement("div");$.className="damage-lab__cooldown-fill",J.append($);const V=document.createElement("div");V.className="damage-lab__actions";const f=document.createElement("button");f.type="button",f.className="damage-lab__button",f.textContent="Hit Player",V.append(f),Y.append(Ee,z,U,J,V),G.append(Ce,O,Y);const q=document.createElement("section");q.className="damage-lab__card";const we=document.createElement("h3");we.textContent="Pierce Simulation";const K=document.createElement("div");K.className="damage-lab__subtle",K.textContent="Projectile tracks hits once per enemy, keeps moving until pierce is exhausted, then destroys or clears the lane.";const Z=document.createElement("div");Z.className="damage-lab__actions";const v=document.createElement("button");v.type="button",v.className="damage-lab__button",v.textContent="Fire",Z.append(v);const Q=document.createElement("div");Q.className="damage-lab__canvas-wrap";const h=document.createElement("canvas");h.className="damage-lab__pierce-canvas",Q.append(h);const ee=document.createElement("div");ee.className="damage-lab__log",q.append(we,K,Z,Q,ee);const ae=document.createElement("section");ae.className="damage-lab__card";const De=document.createElement("h3");De.textContent="DPS Calculator";const te=document.createElement("div");te.className="damage-lab__subtle",te.textContent="Armor curve uses the current lane enemy count as targetCount for multi-hit throughput.";const ne=document.createElement("div");ne.className="damage-lab__stats";const ie=document.createElement("div");ie.className="damage-lab__canvas-wrap";const x=document.createElement("canvas");x.className="damage-lab__chart",ie.append(x),ae.append(De,te,ne,ie),I.append(j,G,q,ae),s.append(k,A);const l=h.getContext("2d"),t=x.getContext("2d");if(!l||!t)throw new Error("Damage lab failed to initialize 2D canvas contexts.");const le=()=>{ee.textContent=S.join(`
`)},oe=e=>{S=[...S,e].slice(-8),le()},Pe=e=>{S=[e],le()},Me=()=>{const e=Math.max(220,Math.floor(h.clientWidth||500)),n=Math.max(1,e-R-ue)/(d.enemyCount+1),r=he/2;return Array.from({length:d.enemyCount},(g,i)=>({id:i+1,x:R+n*(i+1),y:r,flashedUntil:0}))},re=(e="Press Fire to simulate projectile pierce through the lane.")=>{o=null,Pe(e)},se=()=>{ve(h),o={projectileX:R-6,projectileY:he/2,enemies:Me(),hitSet:new Set,hitOrder:[],active:!0,finalState:null},Pe(`Fired projectile for ${d.projectileDamage} damage with pierce ${d.pierceCount}.`)},Se=e=>Number.isFinite(y)?Math.max(0,y+m.invincibilityMs-e):0,Ae=()=>{const e=performance.now();if(Se(e)>0)return;const n=P(m.contactDamage,c.armor);M=Math.max(0,M-n),y=e},Ne=()=>{const e=c.incomingDamage-c.armor,n=P(c.incomingDamage,c.armor);B.innerHTML=`
      <div class="damage-lab__formula-row"><span class="damage-lab__label">Formula</span><span class="damage-lab__value">effectiveDamage = max(1, incoming - armor)</span></div>
      <div class="damage-lab__formula-row"><span class="damage-lab__label">Incoming</span><span class="damage-lab__value">${c.incomingDamage}</span></div>
      <div class="damage-lab__formula-row"><span class="damage-lab__label">Armor</span><span class="damage-lab__value">${c.armor}</span></div>
      <div class="damage-lab__formula-row"><span class="damage-lab__label">incoming - armor</span><span class="damage-lab__value">${c.incomingDamage} - ${c.armor} = ${e}</span></div>
      <div class="damage-lab__formula-row"><span class="damage-lab__label">Clamp</span><span class="damage-lab__value">max(1, ${e}) = ${n}</span></div>
    `},$e=e=>{const n=Oe(M/be,0,1),r=Se(e),g=Oe(m.invincibilityMs>0?r/m.invincibilityMs:0,0,1),i=r>0,u=P(m.contactDamage,c.armor);N.style.width=`${n*100}%`,N.style.backgroundColor=sa(n),X.textContent=`${M} / ${be}`,$.style.width=`${g*100}%`,$.style.backgroundColor=i?w:"rgba(88, 96, 120, 0.5)",U.innerHTML=`
      <div class="damage-lab__stat-row"><span class="damage-lab__label">Allowed hit damage</span><span class="damage-lab__value">${u}</span></div>
      <div class="damage-lab__stat-row"><span class="damage-lab__label">Last hit timestamp</span><span class="damage-lab__value">${Number.isFinite(y)?`${D(y-Ye)} ms`:"Never"}</span></div>
      <div class="damage-lab__stat-row"><span class="damage-lab__label">Cooldown remaining</span><span class="damage-lab__value">${D(r)} ms</span></div>
      <div class="damage-lab__stat-row"><span class="damage-lab__label">Next hit blocked</span><span class="damage-lab__value">${i?"Yes":"No"}</span></div>
    `},Te=e=>{const n=Math.max(1,h.clientWidth),r=Math.max(1,h.clientHeight);l.clearRect(0,0,n,r),l.fillStyle="rgba(9, 14, 28, 0.9)",l.fillRect(0,0,n,r),l.strokeStyle="rgba(126, 224, 255, 0.16)",l.lineWidth=1,l.beginPath(),l.moveTo(R-10,r/2),l.lineTo(n-ue+10,r/2),l.stroke();const g=o?.enemies??Me();for(const i of g){const u=o?.hitSet.has(i.id)??!1;l.fillStyle=e<i.flashedUntil?ta:u?"#8a3a3a":aa,l.beginPath(),l.arc(i.x,i.y,Ge,0,Math.PI*2),l.fill(),l.fillStyle=ge,l.font="11px monospace",l.textAlign="center",l.textBaseline="middle",l.fillText(String(i.id),i.x,i.y)}o&&(l.fillStyle=w,l.beginPath(),l.arc(o.projectileX,o.projectileY,_e,0,Math.PI*2),l.fill())},ze=(e,n)=>{if(!o||!o.active)return;const r=la*(n/(1e3/60));o.projectileX+=r;for(const i of o.enemies)if(!o.hitSet.has(i.id)&&!(o.projectileX+_e<i.x-Ge)&&(o.hitSet.add(i.id),o.hitOrder.push(i.id),i.flashedUntil=e+oa,oe(`Hit enemy ${i.id} for ${d.projectileDamage} damage.`),o.hitOrder.length>d.pierceCount)){o.active=!1,o.finalState="destroyed",oe(`Final state: destroyed after hit ${o.hitOrder.length} exceeded pierce ${d.pierceCount}.`);return}const g=Math.max(1,h.clientWidth||500);o.projectileX-_e>g-ue+20&&(o.active=!1,o.finalState="returned",oe("Final state: returned after clearing the full target row."))},He=()=>{const e=Math.max(1,x.clientWidth),n=Math.max(1,x.clientHeight),r=34,g=10,i=12,u=24,Le=Math.max(1,e-r-g),T=Math.max(1,n-i-u),ke=Math.max(1,d.enemyCount),Ie=Array.from({length:51},(je,H)=>fe(a.damagePerHit,H,a.fireRate,a.pierce,ke)),me=Math.max(...Ie,1);t.clearRect(0,0,e,n),t.fillStyle="rgba(9, 14, 28, 0.92)",t.fillRect(0,0,e,n),t.strokeStyle="rgba(201, 212, 255, 0.18)",t.lineWidth=1,t.beginPath(),t.moveTo(r,i),t.lineTo(r,n-u),t.lineTo(e-g,n-u),t.stroke(),t.fillStyle=pe,t.font="11px monospace",t.textAlign="left",t.textBaseline="middle",t.fillText(`DPS ${D(me)}`,4,16),t.fillText("0",r-12,n-u),t.fillText("Armor",e-42,n-8),t.fillText("50",e-g-8,n-u+12),t.strokeStyle=w,t.lineWidth=2,t.beginPath(),Ie.forEach((je,H)=>{const We=r+H/50*Le,Be=i+T-je/me*T;H===0?t.moveTo(We,Be):t.lineTo(We,Be)}),t.stroke();const Ue=fe(a.damagePerHit,a.targetArmor,a.fireRate,a.pierce,ke),Je=r+a.targetArmor/50*Le,Ve=i+T-Ue/me*T;t.fillStyle="#ffffff",t.beginPath(),t.arc(Je,Ve,3,0,Math.PI*2),t.fill()},Re=()=>{const e=Math.max(1,d.enemyCount),n=P(a.damagePerHit,a.targetArmor),r=Math.min(a.pierce+1,e),g=fe(a.damagePerHit,a.targetArmor,a.fireRate,a.pierce,e);ne.innerHTML=`
      <div class="damage-lab__stat-row"><span class="damage-lab__label">Formula</span><span class="damage-lab__value">max(1, damagePerHit - armor) × fireRate × min(pierce+1, targetCount)</span></div>
      <div class="damage-lab__stat-row"><span class="damage-lab__label">Effective hit damage</span><span class="damage-lab__value">max(1, ${a.damagePerHit} - ${a.targetArmor}) = ${n}</span></div>
      <div class="damage-lab__stat-row"><span class="damage-lab__label">Targets hit</span><span class="damage-lab__value">min(${a.pierce+1}, ${e}) = ${r}</span></div>
      <div class="damage-lab__stat-row"><span class="damage-lab__label">Effective DPS</span><span class="damage-lab__value">${n} × ${D(a.fireRate,1)} × ${r} = ${D(g,1)}</span></div>
    `},_=()=>{Ne(),Re(),$e(performance.now()),Te(performance.now()),He()};f.addEventListener("click",Ae),v.addEventListener("click",se);const ce=b.addFolder("Damage Calculator");ce.add(c,"incomingDamage",1,200,1).name("incomingDamage").onChange(_),ce.add(c,"armor",0,50,1).name("armor").onChange(_),ce.open();const de=b.addFolder("Invincibility");de.add(m,"invincibilityMs",50,1e3,1).name("invincibilityMs").onChange(_),de.add(m,"contactDamage",1,100,1).name("contactDamage").onChange(_),de.open();const Xe={Fire:se},C=b.addFolder("Pierce");C.add(d,"pierceCount",0,10,1).name("pierceCount").onChange(()=>{re(),_()}),C.add(d,"enemyCount",1,10,1).name("enemyCount").onChange(()=>{re(),_()}),C.add(d,"projectileDamage",1,100,1).name("projectileDamage").onChange(()=>{re(),_()}),C.add(Xe,"Fire").name("Fire"),C.open();const E=b.addFolder("DPS");E.add(a,"damagePerHit",1,200,1).name("damagePerHit").onChange(_),E.add(a,"fireRate",.5,20,.5).name("fireRate").onChange(_),E.add(a,"pierce",0,10,1).name("pierce").onChange(_),E.add(a,"targetArmor",0,50,1).name("targetArmor").onChange(_),E.open();const Fe=e=>{if(xe)return;const n=e-L;L=e,ve(h),ve(x),$e(e),ze(e,n),Te(e),He(),F=requestAnimationFrame(Fe)};return Ne(),Re(),le(),F=requestAnimationFrame(Fe),()=>{xe=!0,cancelAnimationFrame(F),f.removeEventListener("click",Ae),v.removeEventListener("click",se),A.remove(),k.remove()}}Ke("damage-lab",{category:"Combat",name:"Damage Lab",description:"Interactive sandbox for validating damage formulas, i-frames, pierce, and DPS.",create:ca});export{ga as t};
