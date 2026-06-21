import{n as O}from"./rolldown-runtime-b3L32Ng1.js";import{Z as T}from"./lab-ai-runner-lab-CPQxw2bT.js";var H=O({});function M(z,C){const r=C.__labGui;if(!r)throw new Error("Lab runner did not initialize lil-gui.");let e="alive",t=null,a;const u={autoKillDelayMs:2e3,simulateOnLoad:!0},b=document.createElement("div");b.className="death-lab";const L=document.createElement("style");L.textContent=`
    .death-lab {
      position: relative;
      min-height: 100%;
      padding: 24px;
      background: radial-gradient(circle at top, #1f0a0a 0%, #111218 40%, #030712 100%);
      color: #f8fafc;
      font-family: Inter, system-ui, sans-serif;
    }
    .death-lab__header { margin-bottom: 20px; }
    .death-lab__title { margin: 0 0 8px; font-size: 28px; font-weight: 700; }
    .death-lab__subtitle { margin: 0; max-width: 720px; color: #cbd5e1; line-height: 1.6; }

    .death-lab__arena {
      position: relative;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 20px;
      padding: 32px;
      border: 1px solid rgba(248,113,113,0.18);
      border-radius: 18px;
      background: rgba(15,23,42,0.9);
      overflow: hidden;
    }

    .death-lab__hp-bar-shell {
      position: relative;
      width: 100%;
      max-width: 480px;
      height: 36px;
      border-radius: 999px;
      border: 1px solid rgba(148,163,184,0.2);
      background: rgba(30,41,59,0.95);
      overflow: hidden;
    }
    .death-lab__hp-bar-fill {
      height: 100%;
      width: 100%;
      border-radius: inherit;
      background: linear-gradient(90deg, #16a34a, #4ade80);
      transition: width 300ms ease, background 300ms ease;
    }
    .death-lab__hp-bar-text {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      font-weight: 700;
      text-shadow: 0 1px 3px rgba(0,0,0,0.7);
    }

    .death-lab__state-badge {
      display: inline-flex;
      align-items: center;
      padding: 6px 18px;
      border-radius: 999px;
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      background: rgba(34,197,94,0.18);
      color: #86efac;
      border: 1px solid rgba(34,197,94,0.35);
      transition: background 300ms, color 300ms, border-color 300ms;
    }
    .death-lab__state-badge.is-dying {
      background: rgba(251,191,36,0.18);
      color: #fde68a;
      border-color: rgba(251,191,36,0.35);
    }
    .death-lab__state-badge.is-dead {
      background: rgba(239,68,68,0.18);
      color: #fca5a5;
      border-color: rgba(239,68,68,0.35);
    }

    .death-lab__actions { display: flex; flex-wrap: wrap; gap: 12px; justify-content: center; }
    .death-lab__button {
      min-width: 140px;
      padding: 12px 20px;
      border-radius: 12px;
      border: 1px solid rgba(148,163,184,0.25);
      background: rgba(30,41,59,0.96);
      color: #f8fafc;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: transform 150ms ease, border-color 150ms ease, background 150ms ease;
    }
    .death-lab__button:hover:enabled {
      transform: translateY(-2px);
      border-color: rgba(96,165,250,0.55);
      background: rgba(37,99,235,0.24);
    }
    .death-lab__button:disabled { cursor: not-allowed; opacity: 0.38; }
    .death-lab__button--kill {
      border-color: rgba(239,68,68,0.4);
      background: rgba(127,29,29,0.4);
    }
    .death-lab__button--kill:hover:enabled {
      border-color: rgba(239,68,68,0.7);
      background: rgba(185,28,28,0.45);
    }

    .death-lab__modal-overlay {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(2,6,23,0.82);
      backdrop-filter: blur(6px);
      opacity: 0;
      pointer-events: none;
      transition: opacity 250ms ease;
    }
    .death-lab__modal-overlay.is-visible {
      opacity: 1;
      pointer-events: auto;
    }
    .death-lab__modal-panel {
      min-width: 320px;
      max-width: 460px;
      padding: 32px 28px;
      border-radius: 20px;
      border: 1px solid rgba(248,113,113,0.35);
      background: rgba(15,23,42,0.98);
      box-shadow: 0 24px 60px rgba(0,0,0,0.45);
      text-align: center;
    }
    .death-lab__modal-title {
      margin: 0 0 6px;
      font-size: 40px;
      font-weight: 800;
      letter-spacing: 0.06em;
      color: #ef4444;
    }
    .death-lab__modal-subtitle {
      margin: 0 0 24px;
      color: #94a3b8;
      font-size: 16px;
    }
    .death-lab__modal-options { display: flex; flex-direction: column; gap: 10px; }
    .death-lab__modal-option {
      padding: 14px 16px;
      border-radius: 12px;
      border: 1px solid rgba(148,163,184,0.22);
      background: rgba(30,41,59,0.96);
      color: #f8fafc;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      text-align: left;
      transition: border-color 150ms, background 150ms;
    }
    .death-lab__modal-option:hover { border-color: rgba(96,165,250,0.55); background: rgba(37,99,235,0.22); }
    .death-lab__modal-option .option-desc { display: block; font-size: 12px; color: #94a3b8; font-weight: 400; margin-top: 2px; }

    .death-lab__result {
      margin-top: 16px;
      font-size: 14px;
      color: #93c5fd;
      min-height: 22px;
      text-align: center;
    }
  `;const _=document.createElement("div");_.className="death-lab__header",_.innerHTML=`
    <h2 class="death-lab__title">Death Screen Lab</h2>
    <p class="death-lab__subtitle">
      Simulates the <code>healthSystem → game_over</code> transition and the Game Over modal.
      When the player's HP hits zero, <code>world.state</code> becomes <code>'game_over'</code>
      and <code>GameOverUI</code> shows — offering Restart or Quit.
    </p>
  `;const x=document.createElement("div");x.className="death-lab__arena";const f=document.createElement("div");f.className="death-lab__hp-bar-shell";const p=document.createElement("div");p.className="death-lab__hp-bar-fill";const v=document.createElement("span");v.className="death-lab__hp-bar-text",f.append(p,v);const m=document.createElement("div");m.className="death-lab__state-badge";const y=document.createElement("div");y.className="death-lab__actions";const o=document.createElement("button");o.type="button",o.className="death-lab__button death-lab__button--kill",o.textContent="💀 Kill Player";const n=document.createElement("button");n.type="button",n.className="death-lab__button",n.textContent="↺ Reset",y.append(o,n);const i=document.createElement("div");i.className="death-lab__result";const g=document.createElement("div");g.className="death-lab__modal-overlay";const h=document.createElement("div");h.className="death-lab__modal-panel",h.innerHTML=`
    <h3 class="death-lab__modal-title">GAME OVER</h3>
    <p class="death-lab__modal-subtitle">You have been slain.</p>
  `;const k=document.createElement("div");k.className="death-lab__modal-options";const s=document.createElement("button");s.type="button",s.className="death-lab__modal-option",s.innerHTML='↺ Restart<span class="option-desc">Start over from the beginning.</span>';const c=document.createElement("button");c.type="button",c.className="death-lab__modal-option",c.innerHTML='← Quit<span class="option-desc">Return to the title screen.</span>',k.append(s,c),h.append(k),g.append(h),x.append(f,m,y,i,g),b.append(L,_,x),z.append(b);function d(){const E=e==="dead"?0:e==="dying"?10:100;p.style.width=`${E}%`,p.style.background=E>50?"linear-gradient(90deg, #16a34a, #4ade80)":E>=10?"linear-gradient(90deg, #ca8a04, #facc15)":"linear-gradient(90deg, #64748b, #94a3b8)",v.textContent=e==="dead"?"0 / 100":e==="dying"?"10 / 100 — dying…":"100 / 100",m.className=`death-lab__state-badge${e==="dead"?" is-dead":e==="dying"?" is-dying":""}`,m.textContent=e==="dead"?"world.state = game_over":e==="dying"?"Taking fatal damage…":"world.state = playing",o.disabled=e!=="alive",n.disabled=e==="alive",g.classList.toggle("is-visible",e==="dead"),t?i.textContent=`Choice recorded: "${t}" — in-game this calls window.location.reload()`:e==="dead"?i.textContent="Select an option above.":i.textContent=""}function w(){e==="alive"&&(e="dying",t=null,d(),a=window.setTimeout(()=>{a=void 0,e="dead",d()},u.autoKillDelayMs))}function N(){a!==void 0&&(clearTimeout(a),a=void 0),e="alive",t=null,d()}o.addEventListener("click",w),n.addEventListener("click",N),s.addEventListener("click",()=>{t="restart",d()}),c.addEventListener("click",()=>{t="quit",d()});const l=typeof r.addFolder=="function"?r.addFolder("Death Lab"):r;return l.add(u,"autoKillDelayMs",0,3e3,100).name("dying → dead (ms)").onChange?.(()=>{}),l.add({killPlayer:w},"killPlayer").name("Kill Player"),l.add({resetAll:N},"resetAll").name("Reset"),l.open?.(),d(),u.simulateOnLoad&&w(),()=>{a!==void 0&&clearTimeout(a),l!==r&&l.destroy?.(),b.remove()}}T("death-lab",{category:"Combat",name:"Death Lab",description:"Visualizes the player-death → game_over transition and Game Over modal options.",create:M});export{H as t};
