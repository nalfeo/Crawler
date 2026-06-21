import{n as ae}from"./rolldown-runtime-b3L32Ng1.js";import{Z as te}from"./lab-ai-runner-lab-GMg0Bszz.js";var se=ae({});function b(c,m){return c.onChange?.(m),c}var ne={maxHealth:100,damageAmount:10,healAmount:10,autoRespawn:!0,respawnDelayMs:2e3};function g(c,m,s,t){return{id:c,label:m,kind:s,currentHealth:t,maxHealth:t,deaths:0,isDead:!1}}function le(c,m){const s=m.__labGui;if(!s)throw new Error("Lab runner did not initialize lil-gui.");const t={...ne},i=[g("player","Contestant Zero","player",t.maxHealth),g("enemy-1","Enemy Alpha","enemy",t.maxHealth),g("enemy-2","Enemy Beta","enemy",t.maxHealth),g("enemy-3","Enemy Gamma","enemy",t.maxHealth),g("enemy-4","Enemy Delta","enemy",t.maxHealth)],T=new Map;let y=!1,d=!1;const f=document.createElement("div");f.className="health-lab";const P=document.createElement("style");P.textContent=`
    .health-lab {
      position: relative;
      min-height: 100%;
      padding: 24px;
      background: radial-gradient(circle at top, #1f2937 0%, #111827 40%, #030712 100%);
      color: #f8fafc;
      font-family: Inter, system-ui, sans-serif;
    }
    .health-lab__header {
      margin-bottom: 20px;
    }
    .health-lab__title {
      margin: 0 0 8px;
      font-size: 28px;
      font-weight: 700;
    }
    .health-lab__subtitle {
      margin: 0;
      max-width: 760px;
      color: #cbd5e1;
      line-height: 1.6;
    }
    .health-lab__grid {
      display: flex;
      flex-wrap: wrap;
      gap: 16px;
      align-items: stretch;
    }
    .health-lab__card {
      flex: 1 1 280px;
      max-width: 360px;
      padding: 16px;
      border-radius: 18px;
      border: 1px solid rgba(148, 163, 184, 0.24);
      background: rgba(15, 23, 42, 0.92);
      box-shadow: 0 18px 40px rgba(0, 0, 0, 0.28);
      transition: opacity 220ms ease, filter 220ms ease, transform 220ms ease;
    }
    .health-lab__card.is-dead {
      opacity: 0.58;
      filter: grayscale(1);
      transform: scale(0.985);
    }
    .health-lab__card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 12px;
    }
    .health-lab__entity-name {
      margin: 0;
      font-size: 18px;
      font-weight: 700;
    }
    .health-lab__badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 4px 10px;
      border-radius: 999px;
      background: rgba(59, 130, 246, 0.18);
      color: #bfdbfe;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .health-lab__card[data-kind='enemy'] .health-lab__badge {
      background: rgba(244, 63, 94, 0.18);
      color: #fecdd3;
    }
    .health-lab__meta,
    .health-lab__status {
      color: #cbd5e1;
      font-size: 14px;
      line-height: 1.5;
    }
    .health-lab__status {
      margin-top: 12px;
      min-height: 22px;
    }
    .health-lab__bar-shell {
      position: relative;
      overflow: hidden;
      margin-top: 14px;
      border-radius: 999px;
      border: 1px solid rgba(148, 163, 184, 0.2);
      background: rgba(30, 41, 59, 0.95);
      height: 28px;
    }
    .health-lab__bar-fill {
      height: 100%;
      width: 100%;
      border-radius: inherit;
      transition: width 220ms ease, background-color 220ms ease;
      background: linear-gradient(90deg, #22c55e, #4ade80);
    }
    .health-lab__bar-text {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.02em;
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.65);
    }
    .health-lab__actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 16px;
    }
    .health-lab__button {
      flex: 1 1 120px;
      border: 1px solid rgba(148, 163, 184, 0.25);
      border-radius: 12px;
      padding: 10px 12px;
      background: rgba(30, 41, 59, 0.96);
      color: #f8fafc;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: transform 160ms ease, border-color 160ms ease, background 160ms ease;
    }
    .health-lab__button:hover:enabled {
      transform: translateY(-1px);
      border-color: rgba(96, 165, 250, 0.55);
      background: rgba(37, 99, 235, 0.24);
    }
    .health-lab__button:disabled {
      cursor: not-allowed;
      opacity: 0.42;
    }
    .health-lab__overlay {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(2, 6, 23, 0.8);
      backdrop-filter: blur(8px);
      opacity: 0;
      pointer-events: none;
      transition: opacity 220ms ease;
    }
    .health-lab__overlay.is-visible {
      opacity: 1;
      pointer-events: auto;
    }
    .health-lab__overlay-panel {
      min-width: 280px;
      padding: 28px 24px;
      border-radius: 20px;
      border: 1px solid rgba(248, 113, 113, 0.4);
      background: rgba(15, 23, 42, 0.96);
      box-shadow: 0 20px 48px rgba(0, 0, 0, 0.35);
      text-align: center;
    }
    .health-lab__overlay-title {
      margin: 0 0 8px;
      color: #f87171;
      font-size: 36px;
      font-weight: 800;
      letter-spacing: 0.08em;
    }
    .health-lab__overlay-copy {
      margin: 0 0 18px;
      color: #cbd5e1;
      line-height: 1.6;
    }
  `;const v=document.createElement("div");v.className="health-lab__header",v.innerHTML=`
    <h2 class="health-lab__title">Health System Visualizer</h2>
    <p class="health-lab__subtitle">Damage and heal entities to mirror the healthSystem flow: the player triggers <code>game_over</code>, while enemies drop an XP gem, fade into a dead state, and respawn on a timer.</p>
  `;const w=document.createElement("div");w.className="health-lab__grid";const p=document.createElement("div");p.className="health-lab__overlay",p.innerHTML=`
    <div class="health-lab__overlay-panel">
      <h3 class="health-lab__overlay-title">GAME OVER</h3>
      <p class="health-lab__overlay-copy">The player reached 0 HP and the system transitioned to <code>game_over</code>.</p>
    </div>
  `;const O=p.firstElementChild,u=document.createElement("button");u.type="button",u.className="health-lab__button",u.textContent="Reset",O.append(u);const x=document.createElement("p");x.textContent="Use lil-gui to tune max HP, button damage/heal values, and enemy respawn timing.",x.style.cssText="padding:8px 16px;margin-top:16px;color:#93c5fd;line-height:1.6;font-family:Inter, system-ui, sans-serif;",f.append(P,v,w,p),c.append(f),m.append(x);function h(e){e.respawnHandle!==void 0&&(window.clearTimeout(e.respawnHandle),e.respawnHandle=void 0)}function z(e){d=e,p.classList.toggle("is-visible",d)}function X(e){return e.maxHealth<=0?0:Math.max(0,Math.min(100,e.currentHealth/e.maxHealth*100))}function U(e,a){return a?"linear-gradient(90deg, #64748b, #94a3b8)":e>50?"linear-gradient(90deg, #16a34a, #4ade80)":e>=25?"linear-gradient(90deg, #ca8a04, #facc15)":"linear-gradient(90deg, #dc2626, #fb7185)"}function V(e){h(e),e.isDead=!1,e.maxHealth=t.maxHealth,e.currentHealth=t.maxHealth,D(e)}function G(e){h(e),!(y||d||e.kind!=="enemy"||!e.isDead||!t.autoRespawn)&&(e.respawnHandle=window.setTimeout(()=>{e.respawnHandle=void 0,y||V(e)},t.respawnDelayMs))}function H(){for(const e of i){if(e.kind!=="enemy"||!e.isDead){h(e);continue}t.autoRespawn&&!d?G(e):h(e)}}function D(e){const a=T.get(e.id);if(!a)return;const n=X(e);a.card.dataset.kind=e.kind,a.card.classList.toggle("is-dead",e.isDead),a.badge.textContent=e.kind==="player"?"Player":"Enemy",a.deathCount.textContent=`Deaths: ${e.deaths}`,a.status.textContent=e.isDead?e.kind==="player"?"💀 Dead • game_over triggered":t.autoRespawn?`💀 Dead • XP gem dropped • respawning in ${Math.round(t.respawnDelayMs/100)/10}s`:"💀 Dead • XP gem dropped • waiting for reset":e.kind==="player"?"Alive • hits 0 HP => game_over":"Alive • hits 0 HP => XP gem + remove entity",a.healthFill.style.width=`${n}%`,a.healthFill.style.background=U(n,e.isDead),a.healthText.textContent=`${Math.max(0,e.currentHealth)} / ${e.maxHealth}`,a.damageDefault.textContent=`Damage -${t.damageAmount}`,a.damageHeavy.textContent="Damage -25",a.heal.textContent=`Heal +${t.healAmount}`;const o=e.isDead||d;a.damageDefault.disabled=o,a.damageHeavy.disabled=o,a.heal.disabled=o,a.kill.disabled=o}function r(){for(const e of i)D(e);p.classList.toggle("is-visible",d)}function $(e){if(!e.isDead){if(e.isDead=!0,e.currentHealth=0,e.deaths+=1,e.kind==="player"){for(const a of i)a.kind==="enemy"&&h(a);z(!0)}else G(e);r()}}function E(e,a){if(e.isDead||d)return;const n=Math.max(0,Math.min(e.maxHealth,e.currentHealth+a));if(e.currentHealth=n,n<=0){$(e);return}D(e)}function Z(){for(const e of i){const a=e.maxHealth>0?e.currentHealth/e.maxHealth:1;e.maxHealth=t.maxHealth,e.currentHealth=e.isDead?0:Math.max(1,Math.round(a*t.maxHealth))}H(),r()}function F(){for(const e of i)h(e),e.maxHealth=t.maxHealth,e.currentHealth=t.maxHealth,e.deaths=0,e.isDead=!1;z(!1),r()}function _(e,a){const n=document.createElement("button");return n.type="button",n.className="health-lab__button",n.textContent=e,n.addEventListener("click",a),n}function K(e){const a=document.createElement("div");a.className="health-lab__card",a.dataset.kind=e.kind;const n=document.createElement("div");n.className="health-lab__card-header";const o=document.createElement("h3");o.className="health-lab__entity-name",o.textContent=e.label;const k=document.createElement("span");k.className="health-lab__badge",n.append(o,k);const C=document.createElement("div");C.className="health-lab__meta";const A=document.createElement("div");A.className="health-lab__bar-shell";const M=document.createElement("div");M.className="health-lab__bar-fill";const N=document.createElement("span");N.className="health-lab__bar-text",A.append(M,N);const L=document.createElement("div");L.className="health-lab__status";const R=document.createElement("div");R.className="health-lab__actions";const S=_("",()=>{E(e,-t.damageAmount)}),j=_("Damage -25",()=>{E(e,-25)}),B=_("",()=>{E(e,t.healAmount)}),I=_("Kill",()=>{$(e)});R.append(S,j,B,I),a.append(n,C,A,L,R),w.append(a),T.set(e.id,{card:a,badge:k,deathCount:C,status:L,healthFill:M,healthText:N,damageDefault:S,damageHeavy:j,heal:B,kill:I})}for(const e of i)K(e);u.addEventListener("click",F);const l=typeof s.addFolder=="function"?s.addFolder("Health Lab"):s,Y=b(l.add(t,"maxHealth",10,500,1).name("maxHealth"),()=>{Z()}),q=b(l.add(t,"damageAmount",1,100,1).name("damageAmount"),()=>{r()}),J=b(l.add(t,"healAmount",1,50,1).name("healAmount"),()=>{r()}),Q=b(l.add(t,"autoRespawn").name("autoRespawn"),()=>{H(),r()}),W=b(l.add(t,"respawnDelayMs",500,5e3,100).name("respawnDelayMs"),()=>{H(),r()}),ee=l.add({resetAll:F},"resetAll").name("Reset All");return l.open?.(),Y.updateDisplay?.(),q.updateDisplay?.(),J.updateDisplay?.(),Q.updateDisplay?.(),W.updateDisplay?.(),ee.updateDisplay?.(),r(),()=>{y=!0;for(const e of i)h(e);l!==s&&l.destroy?.(),f.remove(),x.remove()}}te("health-lab",{category:"Combat",name:"Health Lab",description:"Interactive DOM visualizer for health, death, and respawn behavior.",create:le});export{se as t};
