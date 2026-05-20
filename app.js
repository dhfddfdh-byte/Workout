/* ============================================================
   FORGE — AI strength coach PWA
   Pure vanilla JS. All data local. Gemini powers the AI parts.
   ============================================================ */

/* ---------- State ---------- */
const DEFAULT_STATE = {
  onboarded:false, profile:{}, lifts:{}, program:null,
  logs:[], favorites:[], prs:{},
  nutrition:{plan:null, foodLog:[]},
  body:{weight:[], measurements:[], photos:[]},
  settings:{geminiKey:'', notifications:true},
  active:null // in-progress workout session
};
let S = load();
function load(){try{return Object.assign({},DEFAULT_STATE,JSON.parse(localStorage.getItem('forge')||'{}'));}catch(e){return {...DEFAULT_STATE};}}
function save(){localStorage.setItem('forge',JSON.stringify(S));}

/* ---------- tiny helpers ---------- */
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const el=(t,c,h)=>{const e=document.createElement(t);if(c)e.className=c;if(h!=null)e.innerHTML=h;return e;};
const todayStr=()=>new Date().toISOString().slice(0,10);
const round=(n,d=0)=>{const f=10**d;return Math.round(n*f)/f;};
function toast(msg,type=''){const t=$('#toast');t.className=type;t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2600);}
function vibrate(ms){if(navigator.vibrate)navigator.vibrate(ms);}

/* ============================================================
   STRENGTH SCIENCE  (bodyweight-ratio standards, ExRx-style)
   ============================================================ */
const TIERS=['Untrained','Beginner','Novice','Intermediate','Advanced','Elite'];
// 1RM as multiple of bodyweight, for adult MALE at peak age. [Untr,Beg,Nov,Int,Adv,Elite]
const STD={
  'Bench Press':   [0.50,0.75,1.00,1.25,1.75,2.10],
  'Squat':         [0.75,1.10,1.40,1.80,2.40,3.00],
  'Deadlift':      [1.00,1.40,1.75,2.20,2.80,3.40],
  'Overhead Press':[0.35,0.50,0.65,0.85,1.10,1.40],
  'Barbell Row':   [0.45,0.65,0.85,1.10,1.50,1.90],
  'Pull-up (bw+)': [0.10,0.20,0.35,0.55,0.85,1.20], // added weight as ratio (bw counts as base)
  'Bicep Curl':    [0.18,0.28,0.38,0.50,0.68,0.90],
  'Dumbbell Press':[0.20,0.30,0.42,0.55,0.75,1.00]  // per-hand DB as ratio of bw
};
const LIFT_MUSCLES={
  'Bench Press':['chest','triceps','frontDelt'],
  'Squat':['quads','glutes','hamstrings'],
  'Deadlift':['hamstrings','glutes','back','traps','forearms'],
  'Overhead Press':['frontDelt','sideDelt','triceps'],
  'Barbell Row':['back','lats','rearDelt','biceps'],
  'Pull-up (bw+)':['lats','back','biceps'],
  'Bicep Curl':['biceps','forearms'],
  'Dumbbell Press':['chest','frontDelt','triceps']
};
// female strength relative to male standards
const SEX_FACTOR={male:1, female:0.62};
// age curve: peak 20-30, gentle decline after
function ageFactor(age){
  if(age<=20) return 0.93 + (age-15)*0.014;     // teens slightly lower baseline
  if(age<=30) return 1.0;
  if(age<=40) return 1.0 - (age-30)*0.006;
  if(age<=55) return 0.94 - (age-40)*0.008;
  return Math.max(0.65, 0.82 - (age-55)*0.009);
}
function epley1RM(w,reps){return reps<=1?w:Math.round(w*(1+reps/30));}
// Given a lift name + estimated 1RM, return {tier, idx, pct, next}
function rankLift(lift, oneRM){
  const p=S.profile, bw=+p.weight||180;
  const base=STD[lift]; if(!base) return null;
  const af=ageFactor(+p.age||25), sf=SEX_FACTOR[p.sex]||1;
  const thresholds=base.map(r=>round(r*bw*af*sf,0)); // lb for each tier
  let idx=0; for(let i=0;i<thresholds.length;i++){if(oneRM>=thresholds[i])idx=i;}
  // progress to next tier
  let pct=100, nextW=null, nextTier=null;
  if(idx<TIERS.length-1){
    const lo=idx===0?0:thresholds[idx], hi=thresholds[idx+1];
    pct=Math.min(100,Math.max(0,round(((oneRM-lo)/(hi-lo))*100)));
    nextW=hi; nextTier=TIERS[idx+1];
  }
  return {tier:TIERS[idx], idx, pct, nextW, nextTier, oneRM, thresholds};
}
// overall strength score 0-100 across assessed lifts
function overallRank(){
  const lifts=S.lifts; const ranks=[];
  for(const k in lifts){const l=lifts[k]; if(!l||!l.weight)continue;
    const orm=epley1RM(+l.weight,+l.reps||1); const r=rankLift(k,orm); if(r)ranks.push(r);}
  if(!ranks.length) return {tier:'Untrained',idx:0,pct:0,score:0,count:0};
  const avgIdx=ranks.reduce((a,r)=>a+r.idx+r.pct/100,0)/ranks.length;
  const idx=Math.min(TIERS.length-1,Math.floor(avgIdx));
  const pct=round((avgIdx-idx)*100);
  return {tier:TIERS[idx],idx,pct,score:round(avgIdx/(TIERS.length-1)*100),count:ranks.length};
}
// muscle strength map: aggregate lift ranks onto muscles
function muscleStrength(){
  const m={}; const counts={};
  for(const k in S.lifts){const l=S.lifts[k]; if(!l||!l.weight)continue;
    const orm=epley1RM(+l.weight,+l.reps||1); const r=rankLift(k,orm); if(!r)continue;
    (LIFT_MUSCLES[k]||[]).forEach(mus=>{m[mus]=(m[mus]||0)+(r.idx+r.pct/100);counts[mus]=(counts[mus]||0)+1;});
  }
  const out={}; for(const mus in m){out[mus]=m[mus]/counts[mus];} // 0..5 scale
  return out;
}

/* ---------- BMI / TDEE ---------- */
function calcBMI(){const p=S.profile;const hM=((+p.heightFt||0)*12+(+p.heightIn||0))*0.0254;const kg=(+p.weight||0)*0.4536;if(!hM)return 0;return round(kg/(hM*hM),1);}
function calcTDEE(){
  const p=S.profile;const kg=(+p.weight||0)*0.4536;const cm=((+p.heightFt||0)*12+(+p.heightIn||0))*2.54;const age=+p.age||25;
  let bmr=p.sex==='female'?(10*kg+6.25*cm-5*age-161):(10*kg+6.25*cm-5*age+5);
  const act={2:1.35,3:1.45,4:1.55,5:1.65,6:1.725,7:1.8}[+p.days]||1.5;
  return Math.round(bmr*act);
}
function calorieTarget(){const t=calcTDEE();const g=S.profile.goal;return g==='bulk'?t+350:g==='cut'?t-450:t;}
function macroTarget(){
  const cals=calorieTarget(), kg=(+S.profile.weight||0)*0.4536;
  const protein=Math.round(kg*2.0); // ~1g/lb
  const fat=Math.round(cals*0.25/9);
  const carbs=Math.round((cals-protein*4-fat*9)/4);
  return {cals,protein,carbs,fat};
}

/* ============================================================
   BODY FAT PICKER — 9 distinct illustrated torsos, by sex.
   Definition (abs/separation) fades out and the midsection
   widens/softens as body fat climbs, like a real BF chart.
   ============================================================ */
// 9 levels, each: torso shoulder width, waist width, ab-detail opacity, label, cue
const BF_LEVELS=[
  {pct:'3-4%',  sh:42, wa:26, abs:1.0, vasc:1, cue:'Striated, vascular, paper-thin skin'},
  {pct:'5-7%',  sh:42, wa:27, abs:0.95,vasc:.7,cue:'Full 6-pack, sharp separation'},
  {pct:'8-12%', sh:42, wa:29, abs:0.8, vasc:.3,cue:'Abs clearly visible, lean'},
  {pct:'13-17%',sh:42, wa:32, abs:0.55,vasc:0, cue:'Top abs show, athletic'},
  {pct:'18-23%',sh:42, wa:35, abs:0.3, vasc:0, cue:'Flat, faint outline only'},
  {pct:'24-29%',sh:43, wa:39, abs:0.12,vasc:0, cue:'No definition, soft midsection'},
  {pct:'30-34%',sh:44, wa:44, abs:0,   vasc:0, cue:'Rounder belly, fuller waist'},
  {pct:'35-39%',sh:46, wa:50, abs:0,   vasc:0, cue:'Belly protrudes, soft chest'},
  {pct:'40%+',  sh:48, wa:57, abs:0,   vasc:0, cue:'Large midsection, little shape'}
];
function bodySVG(L,female){
  const cx=60, topY=44, botY=150;
  const sh=L.sh, wa=L.wa;
  const skin='#9aa0aa', shade='#7e848e', line='#5d626b';
  // torso outline: shoulders -> waist, with a slight belly bulge at higher BF
  const belly = wa>40 ? (wa-38)*0.7 : 0;
  const wEff = wa + belly;
  const lx=cx-sh, rx=cx+sh, lw=cx-wEff, rw=cx+wEff;
  const path=`M${lx} ${topY}
    Q${cx} ${topY-9} ${rx} ${topY}
    C${rx+4} ${topY+34} ${rw+belly} ${botY-46} ${rw} ${botY}
    Q${cx} ${botY+8} ${lw} ${botY}
    C${lw-belly} ${botY-46} ${lx-4} ${topY+34} ${lx} ${topY} Z`;
  // pecs
  const pecY=topY+24;
  const pecs=`<path d="M${cx-4} ${pecY-6} Q${cx-sh+8} ${pecY-4} ${cx-sh+10} ${pecY+12} Q${cx-sh+18} ${pecY+20} ${cx-4} ${pecY+16} Z" fill="${shade}" opacity="${female?0.25:0.5}"/>
    <path d="M${cx+4} ${pecY-6} Q${cx+sh-8} ${pecY-4} ${cx+sh-10} ${pecY+12} Q${cx+sh-18} ${pecY+20} ${cx+4} ${pecY+16} Z" fill="${shade}" opacity="${female?0.25:0.5}"/>`;
  // abs grid (opacity by leanness)
  let abs='';
  if(L.abs>0){
    const ax=cx, ay=pecY+22, aw=11, ah=9;
    for(let r=0;r<3;r++){
      abs+=`<rect x="${ax-aw-2}" y="${ay+r*ah}" width="${aw}" height="${ah-2}" rx="2" fill="${shade}" opacity="${L.abs*0.55}"/>`;
      abs+=`<rect x="${ax+2}"    y="${ay+r*ah}" width="${aw}" height="${ah-2}" rx="2" fill="${shade}" opacity="${L.abs*0.55}"/>`;
    }
    abs+=`<line x1="${cx}" y1="${pecY+18}" x2="${cx}" y2="${ay+3*ah}" stroke="${line}" stroke-width="1.5" opacity="${L.abs*0.7}"/>`;
  }
  // belly shading at high BF
  let bellyShade='';
  if(belly>2){bellyShade=`<ellipse cx="${cx}" cy="${botY-30}" rx="${wEff-6}" ry="26" fill="${shade}" opacity="0.3"/>`;}
  // vascularity hint
  let vasc='';
  if(L.vasc>0){vasc=`<path d="M${cx-sh+12} ${pecY+18} q6 10 2 24" stroke="${line}" stroke-width="1" fill="none" opacity="${L.vasc*0.5}"/>
    <path d="M${cx+sh-12} ${pecY+18} q-6 10 -2 24" stroke="${line}" stroke-width="1" fill="none" opacity="${L.vasc*0.5}"/>`;}
  // arms
  const arms=`<path d="M${lx+2} ${topY+2} q-14 4 -16 30 q-1 16 4 30 l7 1 q-1 -22 7 -44 Z" fill="${skin}"/>
    <path d="M${rx-2} ${topY+2} q14 4 16 30 q1 16 -4 30 l-7 1 q1 -22 -7 -44 Z" fill="${skin}"/>`;
  // neck + waistband
  const neck=`<rect x="${cx-9}" y="${topY-14}" width="18" height="18" rx="6" fill="${skin}"/>`;
  const band=`<rect x="${lw}" y="${botY-4}" width="${rw-lw}" height="9" fill="#e7e9ec" opacity="0.9"/>`;
  return `<svg viewBox="0 0 120 170" xmlns="http://www.w3.org/2000/svg">
    ${arms}${neck}
    <path d="${path}" fill="${skin}" stroke="${line}" stroke-width="1"/>
    ${pecs}${bellyShade}${abs}${vasc}${band}
  </svg>`;
}
function renderBF(){
  const g=$('#bfGrid');g.innerHTML='';
  const female=(S.profile.sex==='female');
  BF_LEVELS.forEach((b,i)=>{
    const o=el('button','bf-opt'+(S.profile.bfLevel===i?' on':''),
      bodySVG(b,female)+`<div class="pct">${b.pct}</div><div class="cue">${b.cue}</div>`);
    o.onclick=()=>{S.profile.bfLevel=i;renderBF();};
    g.appendChild(o);
  });
}

/* ============================================================
   ONBOARDING
   ============================================================ */
// Equipment, grouped into real categories incl. household/improvised.
// Each id is what the exercise library filters against.
const EQUIP_CATS=[
  {cat:'Free weights', items:[
    {id:'dumbbells',n:'Dumbbells'},{id:'barbell',n:'Barbell + plates'},
    {id:'kettlebell',n:'Kettlebells'},{id:'ezbar',n:'EZ curl bar'},
    {id:'fixedbar',n:'Fixed-weight bars'},{id:'trapbar',n:'Trap / hex bar'}
  ]},
  {cat:'Racks & benches', items:[
    {id:'rack',n:'Squat rack'},{id:'bench',n:'Adjustable bench'},
    {id:'smith',n:'Smith machine'},{id:'flatbench',n:'Flat bench'}
  ]},
  {cat:'Machines & cables', items:[
    {id:'cables',n:'Cable machine'},{id:'machines',n:'Selectorized machines'},
    {id:'legpress',n:'Leg press'},{id:'legcurl',n:'Leg curl / extension'},
    {id:'latpull',n:'Lat pulldown'},{id:'pec',n:'Pec deck'}
  ]},
  {cat:'Bars & bodyweight', items:[
    {id:'pullup',n:'Pull-up bar'},{id:'dip',n:'Dip station'},
    {id:'rings',n:'Gymnastic rings'},{id:'trx',n:'TRX / suspension'},
    {id:'bodyweight',n:'Bodyweight only'},{id:'parallettes',n:'Parallettes'}
  ]},
  {cat:'Bands & accessories', items:[
    {id:'bands',n:'Resistance bands'},{id:'miniband',n:'Mini loop bands'},
    {id:'jumprope',n:'Jump rope'},{id:'abwheel',n:'Ab wheel'},
    {id:'medball',n:'Medicine ball'},{id:'sandbag',n:'Sandbag'}
  ]},
  {cat:'Home / improvised', items:[
    {id:'backpack',n:'Loaded backpack'},{id:'books',n:'Books / heavy objects'},
    {id:'jugs',n:'Water jugs / gallons'},{id:'chair',n:'Sturdy chair'},
    {id:'counter',n:'Counter (for dips)'},{id:'table',n:'Table (for rows)'},
    {id:'doorbar',n:'Doorway bar'},{id:'towel',n:'Towel'},
    {id:'stairs',n:'Stairs / step'},{id:'wall',n:'Wall'},
    {id:'crate',n:'Box / crate'},{id:'suitcase',n:'Filled suitcase'}
  ]}
];
const PRIORITY_MUSCLES=[
  {id:'chest',n:'Chest'},{id:'back',n:'Back / Lats'},{id:'biceps',n:'Biceps'},
  {id:'triceps',n:'Triceps'},{id:'sideDelt',n:'Shoulders'},{id:'quads',n:'Quads'},
  {id:'hamstrings',n:'Hamstrings'},{id:'glutes',n:'Glutes'},{id:'abs',n:'Abs / Core'},
  {id:'calves',n:'Calves'},{id:'forearms',n:'Forearms'},{id:'traps',n:'Traps'}
];
const ASSESS_LIFTS=['Bench Press','Squat','Deadlift','Overhead Press','Barbell Row','Bicep Curl'];
let customEquip=[]; // user-added equipment ids
let onbStep=0; const ONB_MAX=9;

function initOnb(){
  if(S.onboarded){showApp();return;}
  // chip group handlers (single-select groups)
  document.addEventListener('click',e=>{
    const c=e.target.closest('.chip[data-g]'); if(!c)return;
    const g=c.dataset.g, v=c.dataset.v;
    if(c.classList.contains('multi')){c.classList.toggle('on');}
    else{$$(`.chip[data-g="${g}"]`).forEach(x=>x.classList.remove('on'));c.classList.add('on');}
    onbCache[g]=v;
  });
  renderBF();
  renderEquip();
  renderPriority();
  // days 2-7 + custom
  const dc=$('#daysChips');[2,3,4,5,6,7].forEach(d=>{const b=el('button','chip');b.dataset.g='i_days';b.dataset.v=d;b.textContent=d;dc.appendChild(b);});
  // program length
  const lc=$('#lenChips');[['1','1 month'],['2','2 months'],['3','3 months'],['6','6 months'],['ongoing','Ongoing']].forEach(([v,t])=>{const b=el('button','chip');b.dataset.g='i_len';b.dataset.v=v;b.textContent=t;lc.appendChild(b);});
  renderWeights();
  renderAssess();
  $('#onbNext').onclick=onbNextFn;
  $('#onbBack').onclick=()=>{if(onbStep>0){onbStep--;showOnbStep();}};
  showOnbStep();
}
const onbCache={};

function renderEquip(){
  const wrap=$('#equipCats');
  // preserve any currently-selected chips (incl. before save() commits them)
  const onScreen=$$('#equipCats .chip.on').map(c=>c.dataset.eq);
  const selected=new Set((S.profile.equipment||[]).concat(onScreen));
  wrap.innerHTML='';
  EQUIP_CATS.forEach(cat=>{
    const items=cat.items.concat(customEquip.filter(c=>c.cat===cat.cat).map(c=>({id:c.id,n:c.n,custom:true})));
    const d=el('div','eq-cat',`<div class="ct">${cat.cat}</div>`);
    const chips=el('div','chips');
    items.forEach(it=>{
      const b=el('button','chip multi'+(selected.has(it.id)?' on':''),it.n+(it.custom?' ✏️':''));
      b.dataset.eq=it.id;b.onclick=()=>b.classList.toggle('on');
      chips.appendChild(b);
    });
    d.appendChild(chips);wrap.appendChild(d);
  });
}
function addCustomEquip(){
  modal(`<h3>Add custom equipment</h3>
    <div class="field"><label>Name it</label><input class="inp" id="ce_name" placeholder="e.g. Tire, log, weighted vest"></div>
    <div class="field"><label>Category</label>
      <select class="inp" id="ce_cat">${EQUIP_CATS.map(c=>`<option>${c.cat}</option>`).join('')}</select></div>
    <button class="btn" onclick="saveCustomEquip()">Add</button>`);
}
function saveCustomEquip(){
  const name=$('#ce_name').value.trim();if(!name){toast('Name it first','bad');return;}
  const id='custom_'+name.toLowerCase().replace(/\W/g,'_');
  customEquip.push({id,n:name,cat:$('#ce_cat').value});
  closeModal();renderEquip();toast('Added — now tap to select it','good');
}

function renderPriority(){
  const wrap=$('#priorityChips');wrap.innerHTML='';
  const sel=new Set(S.profile.priority||[]);
  PRIORITY_MUSCLES.forEach(m=>{
    const b=el('button','chip multi'+(sel.has(m.id)?' on':''),m.n);
    b.dataset.pri=m.id;b.onclick=()=>b.classList.toggle('on');
    wrap.appendChild(b);
  });
}

function renderWeights(){
  const eq=new Set($$('#equipCats .chip.on').map(c=>c.dataset.eq).concat(S.profile.equipment||[]));
  const sec=$('#weightSection');sec.innerHTML='';
  // Dumbbells
  const dbOwned=new Set(S.profile.dumbbells||[]);
  const dbGroup=el('div','wgroup',`<div class="wl">Dumbbells (lb)</div><div class="wh">Tap each pair you own</div>`);
  const dbInv=el('div','winv');
  [3,5,8,10,12,15,20,25,30,35,40,45,50,55,60,65,70,75,80,90,100].forEach(w=>{
    const b=el('button','w'+(dbOwned.has(w)?' on':''),w);b.dataset.w=w;b.dataset.k='db';b.onclick=()=>b.classList.toggle('on');dbInv.appendChild(b);});
  dbGroup.appendChild(dbInv);
  dbGroup.appendChild(customWeightAdder('db'));
  sec.appendChild(dbGroup);
  // Kettlebells (only if owned)
  if(eq.has('kettlebell')){
    const kbOwned=new Set(S.profile.kettlebells||[]);
    const kbGroup=el('div','wgroup',`<div class="wl">Kettlebells (lb)</div>`);
    const kbInv=el('div','winv');
    [9,13,18,26,35,44,53,62,70].forEach(w=>{const b=el('button','w'+(kbOwned.has(w)?' on':''),w);b.dataset.w=w;b.dataset.k='kb';b.onclick=()=>b.classList.toggle('on');kbInv.appendChild(b);});
    kbGroup.appendChild(kbInv);kbGroup.appendChild(customWeightAdder('kb'));
    sec.appendChild(kbGroup);
  }
  // Barbell note
  if(eq.has('barbell')||eq.has('smith')||eq.has('ezbar')){
    sec.appendChild(el('div','wgroup',`<div class="wl">Barbell</div><div class="wh">I'll assume a 45lb bar with standard plates (2.5–45) and 5lb jumps. Add micro-plates in settings later if you have them.</div>`));
  }
  // Household improvised note
  const household=['backpack','books','jugs','sandbag','suitcase','crate'].some(h=>eq.has(h));
  if(household){
    sec.appendChild(el('div','wgroup',`<div class="wl">Improvised load</div><div class="wh">For backpacks, jugs, sandbags etc. you'll set the weight when you log — I'll progress reps and load from there.</div>`));
  }
}
function customWeightAdder(kind){
  const wrap=el('div','addw');
  const inp=el('input');inp.type='number';inp.inputMode='decimal';inp.placeholder='Add custom weight';
  const btn=el('button','btn ghost sm','Add');btn.style.flex='0 0 auto';
  btn.onclick=()=>{const v=+inp.value;if(!v)return;
    const inv=wrap.parentElement.querySelector('.winv');
    if([...inv.querySelectorAll('.w')].some(w=>+w.dataset.w===v)){toast('Already there','bad');return;}
    const b=el('button','w on',v);b.dataset.w=v;b.dataset.k=kind;b.onclick=()=>b.classList.toggle('on');
    inv.appendChild(b);inp.value='';};
  wrap.appendChild(inp);wrap.appendChild(btn);return wrap;
}

function renderAssess(){
  const al=$('#assessList');al.innerHTML='';
  ASSESS_LIFTS.forEach(lift=>{
    const r=el('div','lift-row',
      `<div class="nm">${lift}<span class="tier tier-Untrained" id="tier_${lift.replace(/\W/g,'')}">—</span></div>
       <div class="row" style="align-items:center">
         <input class="inp" type="number" inputmode="decimal" placeholder="weight (lb)" data-lift="${lift}" data-f="weight">
         <input class="inp" type="number" inputmode="numeric" placeholder="reps" data-lift="${lift}" data-f="reps">
         <button class="dunno" data-dunno="${lift}">I don't know</button>
       </div>`);
    al.appendChild(r);
  });
  al.addEventListener('click',e=>{
    const btn=e.target.closest('.dunno');if(!btn)return;
    const lift=btn.dataset.dunno;const row=btn.closest('.lift-row');
    btn.classList.toggle('on');
    const off=btn.classList.contains('on');
    row.classList.toggle('unknown',off);
    row.querySelectorAll('input').forEach(i=>{i.disabled=off;if(off)i.value='';});
    const t=$('#tier_'+lift.replace(/\W/g,''));
    if(off){S.lifts[lift]={unknown:true};t.textContent='Untrained';t.className='tier tier-Untrained';}
    else{delete S.lifts[lift];t.textContent='—';t.className='tier tier-Untrained';}
  });
  al.addEventListener('input',e=>{
    const lift=e.target.dataset.lift;if(!lift)return;
    const w=al.querySelector(`[data-lift="${lift}"][data-f="weight"]`).value;
    const reps=al.querySelector(`[data-lift="${lift}"][data-f="reps"]`).value;
    if(w&&reps){
      S.lifts[lift]={weight:+w,reps:+reps};
      if(S.profile.weight){const r=rankLift(lift,epley1RM(+w,+reps));
        const t=$('#tier_'+lift.replace(/\W/g,''));if(r){t.textContent=r.tier;t.className='tier tier-'+r.tier;}}
    }
  });
}

function showOnbStep(){
  $$('.onb-step').forEach(s=>s.classList.toggle('active',+s.dataset.step===onbStep));
  $('#onbBar').style.width=(onbStep/ONB_MAX*100)+'%';
  $('#onbBack').style.display=onbStep>0&&onbStep<ONB_MAX?'':'none';
  if(onbStep===5)renderWeights(); // refresh weights to match chosen equipment
  const next=$('#onbNext');
  next.textContent=onbStep===0?'Get Started':onbStep===8?'Build My Program':onbStep===7?'Continue':'Continue';
  next.style.display=onbStep===ONB_MAX?'none':'';
  window.scrollTo(0,0);
}
function captureStep(){
  if(onbStep===1){
    S.profile.name=$('#i_name').value.trim()||'Athlete';
    S.profile.age=+$('#i_age').value;
    S.profile.sex=onbCache.i_sex||'male';
    S.profile.heightFt=+$('#i_ft').value;S.profile.heightIn=+$('#i_in').value;
    S.profile.weight=+$('#i_wt').value;
    if(!S.profile.age||!S.profile.weight){toast('Add your age and weight','bad');return false;}
  }
  if(onbStep===2){if(!onbCache.i_goal){toast('Pick a goal','bad');return false;}S.profile.goal=onbCache.i_goal;}
  if(onbStep===4){
    S.profile.equipment=$$('#equipCats .chip.on').map(c=>c.dataset.eq);
    S.profile.customEquip=customEquip;
    if(!S.profile.equipment.length){toast('Pick at least one','bad');return false;}
  }
  if(onbStep===5){
    S.profile.dumbbells=$$('#weightSection .w.on[data-k="db"]').map(w=>+w.dataset.w).sort((a,b)=>a-b);
    S.profile.kettlebells=$$('#weightSection .w.on[data-k="kb"]').map(w=>+w.dataset.w).sort((a,b)=>a-b);
  }
  if(onbStep===6){
    S.profile.days=+onbCache.i_days||4;
    S.profile.workoutMin=+onbCache.i_dur||60;
    S.profile.experience=onbCache.i_exp||'some';
    S.profile.lengthMonths=onbCache.i_len||'3';
    S.profile.injuries=$('#i_injury').value.trim();
    S.profile.hated=$('#i_hate').value.trim();
  }
  if(onbStep===7){
    S.profile.priority=$$('#priorityChips .chip.on').map(c=>c.dataset.pri);
  }
  return true;
}
function onbNextFn(){
  if(!captureStep())return;
  if(onbStep===8){save();buildProgram();return;}
  onbStep++;showOnbStep();
}

/* ============================================================
   EXERCISE LIBRARY  (filtered by equipment)
   movement cues used for the animated form illustration
   ============================================================ */
const EXLIB={
  chest:[
    {n:'Barbell Bench Press',eq:['barbell','rack','bench'],c:'Lower bar to mid-chest, drive up. Keep shoulder blades pinned.'},
    {n:'Dumbbell Bench Press',eq:['dumbbells','bench','flatbench'],c:'Press DBs over chest, control the stretch at bottom.'},
    {n:'Incline Dumbbell Press',eq:['dumbbells','bench'],c:'Bench at 30°. Targets upper chest.'},
    {n:'Dumbbell Fly',eq:['dumbbells','bench'],c:'Slight elbow bend, hug a tree motion.'},
    {n:'Cable Crossover',eq:['cables'],c:'Squeeze chest at the bottom of the arc.'},
    {n:'Machine Chest Press',eq:['machines','pec'],c:'Press handles together, control the return.'},
    {n:'Push-up',eq:['bodyweight','wall'],c:'Body in a straight line, full range.'},
    {n:'Backpack Push-up',eq:['backpack','books'],c:'Wear a loaded pack for extra resistance.'},
    {n:'Chair Dips (chest lean)',eq:['chair','counter'],c:'Lean forward off two chairs to bias chest.'},
    {n:'Banded Chest Press',eq:['bands'],c:'Anchor behind you, press forward and squeeze.'}
  ],
  back:[
    {n:'Barbell Row',eq:['barbell','trapbar'],c:'Hinge ~45°, pull to lower ribs, squeeze.'},
    {n:'Pull-up',eq:['pullup','doorbar','rings'],c:'Dead hang to chin over bar. Add weight when easy.'},
    {n:'Lat Pulldown',eq:['cables','machines','latpull'],c:'Pull to upper chest, drive elbows down.'},
    {n:'Dumbbell Row',eq:['dumbbells','bench'],c:'One knee on bench, row DB to hip.'},
    {n:'Kettlebell Row',eq:['kettlebell'],c:'Hinge, row KB to hip, control down.'},
    {n:'Seated Cable Row',eq:['cables','machines'],c:'Pull to navel, chest tall.'},
    {n:'Inverted Row',eq:['bodyweight','barbell','table','rings','trx'],c:'Body straight, pull chest to bar/table edge.'},
    {n:'Backpack Row',eq:['backpack','jugs','books'],c:'Hinge over, row the load to your hip.'},
    {n:'Towel Door Row',eq:['towel','doorbar'],c:'Loop a towel, lean back, pull yourself in.'},
    {n:'Banded Row',eq:['bands','miniband'],c:'Anchor low, row elbows back, squeeze.'},
    {n:'Suitcase Row',eq:['suitcase','crate'],c:'Row a heavy bag/crate to the hip.'}
  ],
  quads:[
    {n:'Back Squat',eq:['barbell','rack','smith'],c:'Brace, sit between hips, drive through midfoot.'},
    {n:'Goblet Squat',eq:['dumbbells','kettlebell'],c:'Hold weight at chest, squat deep.'},
    {n:'Leg Press',eq:['machines','legpress'],c:'Full range, don\'t lock knees hard.'},
    {n:'Bulgarian Split Squat',eq:['dumbbells','bodyweight','chair','kettlebell'],c:'Rear foot elevated on a chair, drop straight down.'},
    {n:'Walking Lunge',eq:['dumbbells','bodyweight','backpack'],c:'Long stride, knee tracks over toe.'},
    {n:'Backpack Squat',eq:['backpack','books','jugs'],c:'Hold the load at your chest and squat.'},
    {n:'Step-up',eq:['chair','stairs','crate','box','dumbbells'],c:'Step onto a sturdy chair/step, drive through the heel.'},
    {n:'Wall Sit',eq:['wall','bodyweight'],c:'Back flat on wall, thighs parallel, hold.'},
    {n:'Bodyweight Squat',eq:['bodyweight'],c:'Sit back and down, full depth, stand tall.'}
  ],
  hamstrings:[
    {n:'Romanian Deadlift',eq:['barbell','dumbbells','trapbar'],c:'Hinge at hips, slight knee bend, feel hamstring stretch.'},
    {n:'Leg Curl',eq:['machines','legcurl'],c:'Squeeze hamstrings, control negative.'},
    {n:'Dumbbell RDL',eq:['dumbbells','kettlebell'],c:'Push hips back, weight close to legs.'},
    {n:'Backpack RDL',eq:['backpack','jugs','books'],c:'Hold the load, hinge, feel the stretch.'},
    {n:'Nordic Curl',eq:['bodyweight','chair'],c:'Anchor feet, lower slowly, fight gravity.'},
    {n:'Single-Leg Hip Hinge',eq:['bodyweight','dumbbells'],c:'Balance on one leg, hinge with flat back.'}
  ],
  glutes:[
    {n:'Hip Thrust',eq:['barbell','dumbbells','bench','chair'],c:'Shoulders on a chair/bench, drive hips up, squeeze.'},
    {n:'Deadlift',eq:['barbell','trapbar'],c:'Brace, push floor away, lock out tall.'},
    {n:'Glute Bridge',eq:['bodyweight','dumbbells','backpack'],c:'Squeeze at top, posterior pelvic tilt.'},
    {n:'Kettlebell Swing',eq:['kettlebell'],c:'Hinge and snap hips, glutes drive it.'},
    {n:'Banded Glute Kickback',eq:['bands','miniband'],c:'Drive heel back, squeeze glute.'}
  ],
  frontDelt:[
    {n:'Overhead Press',eq:['barbell','rack','smith'],c:'Press overhead, ribs down, lock out.'},
    {n:'Dumbbell Shoulder Press',eq:['dumbbells'],c:'Press DBs overhead, don\'t flare wrists.'},
    {n:'Arnold Press',eq:['dumbbells'],c:'Rotate from palms-in to overhead.'},
    {n:'Kettlebell Press',eq:['kettlebell'],c:'Press KB overhead, stack the wrist.'},
    {n:'Backpack Overhead Press',eq:['backpack','jugs','books'],c:'Press the load straight overhead.'},
    {n:'Pike Push-up',eq:['bodyweight','wall'],c:'Hips high, press head toward floor.'}
  ],
  sideDelt:[
    {n:'Lateral Raise',eq:['dumbbells','cables'],c:'Lead with elbows, raise to shoulder height.'},
    {n:'Cable Lateral Raise',eq:['cables'],c:'Constant tension, slow tempo.'},
    {n:'Banded Lateral Raise',eq:['bands','miniband'],c:'Stand on band, raise to the sides.'},
    {n:'Jug Lateral Raise',eq:['jugs','books'],c:'Raise light loads to shoulder height.'},
    {n:'Upright Row',eq:['dumbbells','barbell','kettlebell'],c:'Pull to chest, elbows high.'}
  ],
  rearDelt:[
    {n:'Reverse Fly',eq:['dumbbells','cables','bands'],c:'Hinge over, sweep arms back like wings.'},
    {n:'Face Pull',eq:['cables','bands'],c:'Pull rope to face, externally rotate.'},
    {n:'Backpack Bent Fly',eq:['jugs','books'],c:'Hinge over, raise light loads out wide.'}
  ],
  biceps:[
    {n:'Barbell Curl',eq:['barbell','ezbar'],c:'Elbows pinned, curl, slow lower.'},
    {n:'Dumbbell Curl',eq:['dumbbells'],c:'Supinate, squeeze at top.'},
    {n:'Hammer Curl',eq:['dumbbells','kettlebell'],c:'Neutral grip, hits brachialis.'},
    {n:'Cable Curl',eq:['cables'],c:'Constant tension throughout.'},
    {n:'Banded Curl',eq:['bands'],c:'Stand on band, curl with control.'},
    {n:'Backpack Curl',eq:['backpack','jugs'],c:'Curl the load, elbows fixed.'},
    {n:'Towel Iso Curl',eq:['towel','doorbar'],c:'Curl against a towel anchored under your feet.'}
  ],
  triceps:[
    {n:'Close-Grip Bench',eq:['barbell','rack','bench'],c:'Tuck elbows, press, tricep focus.'},
    {n:'Tricep Pushdown',eq:['cables'],c:'Elbows fixed, full extension.'},
    {n:'Overhead Tricep Ext',eq:['dumbbells','kettlebell'],c:'Lower weight behind head, extend.'},
    {n:'Dips',eq:['bodyweight','pullup','dip','chair','counter','parallettes'],c:'Lean slightly, full depth on bars/chairs/counter.'},
    {n:'Skull Crusher',eq:['dumbbells','barbell','ezbar','bench'],c:'Lower to forehead, extend.'},
    {n:'Diamond Push-up',eq:['bodyweight'],c:'Hands together, elbows tucked.'},
    {n:'Banded Pushdown',eq:['bands'],c:'Anchor high, push down, lock out.'}
  ],
  forearms:[
    {n:'Wrist Curl',eq:['dumbbells','barbell'],c:'Curl just the wrists, full range.'},
    {n:'Farmer Carry',eq:['dumbbells','kettlebell','jugs','suitcase','backpack'],c:'Heavy, walk tall, grip hard.'},
    {n:'Towel Hang',eq:['pullup','doorbar','towel'],c:'Hang from a towel — brutal grip work.'}
  ],
  abs:[
    {n:'Hanging Leg Raise',eq:['pullup','doorbar'],c:'Raise legs to 90°, control down.'},
    {n:'Cable Crunch',eq:['cables'],c:'Crunch ribs to pelvis, round spine.'},
    {n:'Ab Wheel Rollout',eq:['abwheel'],c:'Roll out slow, brace, pull back.'},
    {n:'Plank',eq:['bodyweight','wall'],c:'Brace hard, straight line, hold.'},
    {n:'Hollow Hold',eq:['bodyweight'],c:'Lower back flat, hold.'},
    {n:'Bicycle Crunch',eq:['bodyweight'],c:'Opposite elbow to knee, controlled.'},
    {n:'Weighted Crunch',eq:['backpack','books','dumbbells'],c:'Hold load on chest, crunch up.'}
  ],
  calves:[
    {n:'Standing Calf Raise',eq:['dumbbells','machines','bodyweight','stairs','backpack'],c:'Full stretch, full squeeze, pause top.'},
    {n:'Seated Calf Raise',eq:['machines','dumbbells'],c:'Targets soleus, slow reps.'}
  ],
  lats:[]  // covered by back
};
const MUSCLE_LABELS={warmup:'Warm-up',chest:'Chest',back:'Back',lats:'Lats',quads:'Quads',hamstrings:'Hamstrings',glutes:'Glutes',frontDelt:'Front Delts',sideDelt:'Side Delts',rearDelt:'Rear Delts',biceps:'Biceps',triceps:'Triceps',forearms:'Forearms',abs:'Abs',calves:'Calves',traps:'Traps'};

function pickExercise(muscle,exclude){
  const eq=S.profile.equipment||['bodyweight'];
  const hated=(S.profile.hated||'').toLowerCase().split(/[,;]/).map(h=>h.trim()).filter(Boolean);
  const injured=(S.profile.injuries||'').toLowerCase();
  const list=(EXLIB[muscle]||[]).filter(x=>
    x.eq.some(e=>eq.includes(e)) &&
    !hated.some(h=>x.n.toLowerCase().includes(h)) &&
    !(exclude&&exclude.has(x.n))
  );
  // de-prioritize exercises that obviously stress an injured area (best-effort keyword match)
  const safe=list.filter(x=>{
    if(injured.includes('shoulder')&&/overhead|press|dip|lateral/i.test(x.n))return false;
    if(injured.includes('knee')&&/squat|lunge|leg press|step-up/i.test(x.n))return false;
    if((injured.includes('back')||injured.includes('spine'))&&/deadlift|barbell row|good morning/i.test(x.n))return false;
    return true;
  });
  return (safe[0]||list[0]||(EXLIB[muscle]||[])[0]);
}

/* ---------- weights snapping to what you own ---------- */
function availableWeights(ex){
  const dbs=S.profile.dumbbells||[];
  const kbs=S.profile.kettlebells||[];
  const eq=S.profile.equipment||[];
  if(/kettlebell|swing/i.test(ex.n) && kbs.length) return kbs;
  if(/dumbbell|db |goblet|hammer|lateral|fly|curl|raise|farmer|arnold|rdl/i.test(ex.n) && dbs.length) return dbs;
  if((eq.includes('barbell')||eq.includes('smith')||eq.includes('ezbar')) && /barbell|bench|squat|deadlift|press|row|curl|skull|close-grip/i.test(ex.n)){
    const out=[];for(let w=45;w<=405;w+=5)out.push(w);return out;
  }
  if(dbs.length) return dbs;
  if(kbs.length) return kbs;
  return null; // bodyweight / improvised — no fixed weight
}
function suggestStartWeight(ex,muscle){
  const avail=availableWeights(ex);
  if(!avail) return null; // bodyweight/improvised: user sets load when logging
  const ms=muscleStrength()[muscle]||0; // 0..5
  // experience nudges the starting point: beginners start lighter
  const expAdj={new:-0.12, some:0, exp:0.08}[S.profile.experience]||0;
  const frac=Math.min(0.92,Math.max(0.1,0.2+ms*0.12+expAdj));
  const idx=Math.min(avail.length-1,Math.max(0,Math.floor(avail.length*frac)));
  return avail[idx]||avail[0];
}

/* ============================================================
   PROGRAM GENERATION
   ============================================================ */
function splitFor(days){
  if(days<=2) return [
    {name:'Full Body A',muscles:['quads','chest','back','sideDelt','biceps','abs']},
    {name:'Full Body B',muscles:['hamstrings','frontDelt','back','triceps','glutes','calves']}
  ];
  if(days===3) return [
    {name:'Full Body A',muscles:['quads','chest','back','sideDelt','biceps','abs']},
    {name:'Full Body B',muscles:['hamstrings','frontDelt','back','triceps','glutes','calves']},
    {name:'Full Body C',muscles:['chest','quads','back','rearDelt','biceps','abs']}
  ];
  if(days===4) return [
    {name:'Upper A',muscles:['chest','back','sideDelt','biceps','triceps']},
    {name:'Lower A',muscles:['quads','hamstrings','glutes','calves','abs']},
    {name:'Upper B',muscles:['back','frontDelt','chest','triceps','biceps']},
    {name:'Lower B',muscles:['hamstrings','quads','glutes','calves','abs']}
  ];
  const ppl=[
    {name:'Push',muscles:['chest','frontDelt','sideDelt','triceps']},
    {name:'Pull',muscles:['back','lats','rearDelt','biceps','forearms']},
    {name:'Legs',muscles:['quads','hamstrings','glutes','calves','abs']},
    {name:'Push',muscles:['chest','sideDelt','triceps','frontDelt']},
    {name:'Pull',muscles:['back','biceps','rearDelt','forearms']},
    {name:'Legs',muscles:['hamstrings','quads','glutes','calves','abs']}
  ];
  return days===5?ppl.slice(0,5):ppl; // 5 or 6
}
function repScheme(){
  const g=S.profile.goal,exp=S.profile.experience;
  if(g==='cut') return {sets:3,reps:'10-15',rest:60};
  if(exp==='new') return {sets:3,reps:'8-12',rest:90};
  if(exp==='exp') return {sets:4,reps:'5-12',rest:120};
  return {sets:4,reps:'6-12',rest:105};
}
// how many exercises fit a session of N minutes (warmup + ~ per-exercise time)
function exercisesForTime(min){
  const usable=Math.max(12,min-8); // 8 min warmup
  return Math.max(3,Math.min(8,Math.round(usable/9))); // ~9 min per exercise
}
function warmupFor(day){
  // generic, joint-friendly warmup block tuned to the day's focus
  const lower=day.muscles.some(m=>['quads','hamstrings','glutes','calves'].includes(m));
  const items=lower
    ? ['5 min easy cardio / brisk walk','Leg swings × 10 each','Bodyweight squats × 15','Glute bridges × 15','2 light ramp-up sets of your first lift']
    : ['5 min easy cardio / arm circles','Band pull-aparts × 15','Scapular push-ups × 10','Arm/shoulder rotations × 10','2 light ramp-up sets of your first lift'];
  return {name:'Warm-up',muscle:'warmup',cue:'Raise your heart rate and prime the joints you\'re about to train.',warmup:true,items,sets:1,reps:'~8 min',rest:0,weight:null};
}
function buildLocalProgram(){
  const days=S.profile.days||4;
  const split=splitFor(days);
  const scheme=repScheme();
  const maxEx=exercisesForTime(S.profile.workoutMin||60);
  const priority=new Set(S.profile.priority||[]);
  const program={days, scheme, week:1, workoutMin:S.profile.workoutMin||60,
    lengthMonths:S.profile.lengthMonths||'3', startDate:todayStr(),
    split:split.map(d=>{
    const exercises=[];const used=new Set();
    // order muscles so prioritized ones come first (more volume / earlier when fresh)
    const ordered=d.muscles.slice().sort((a,b)=>(priority.has(b)?1:0)-(priority.has(a)?1:0));
    ordered.forEach(m=>{
      const ex=pickExercise(m,used);if(!ex||used.has(ex.n))return;used.add(ex.n);
      const isPriority=priority.has(m);
      exercises.push({name:ex.n,muscle:m,cue:ex.c,
        sets:scheme.sets+(isPriority?1:0), // extra set for priority muscles
        reps:scheme.reps,
        weight:suggestStartWeight(ex,m),rest:scheme.rest,priority:isPriority});
    });
    // add a 2nd exercise for each priority muscle if time allows
    if(exercises.length<maxEx){
      ordered.filter(m=>priority.has(m)).forEach(m=>{
        if(exercises.length>=maxEx)return;
        const ex=pickExercise(m,used);if(!ex||used.has(ex.n))return;used.add(ex.n);
        exercises.push({name:ex.n,muscle:m,cue:ex.c,sets:scheme.sets,reps:scheme.reps,
          weight:suggestStartWeight(ex,m),rest:scheme.rest,priority:true});
      });
    }
    // trim to time budget (keep priority + compounds first since they're ordered first)
    const trimmed=exercises.slice(0,maxEx);
    return {name:d.name,exercises:[warmupFor(d),...trimmed]};
  })};
  // weekly schedule with rest days spread out
  const schedule=[];
  const trainDays=program.split.length;
  const map={2:[1,4],3:[0,2,4],4:[0,1,3,4],5:[0,1,2,4,5],6:[0,1,2,3,4,5],7:[0,1,2,3,4,5,6]}[trainDays]||[0,1,3,4];
  for(let i=0;i<7;i++){const w=map.indexOf(i);schedule.push(w>=0?{type:'train',idx:w}:{type:'rest'});}
  program.baseSchedule=JSON.parse(JSON.stringify(schedule)); // remember the template
  program.schedule=schedule;
  return program;
}

async function buildProgram(){
  $('#onbNext').style.display='none';$('#onbBack').style.display='none';
  showOnbStep=()=>{};onbStep=8;
  $$('.onb-step').forEach(s=>s.classList.toggle('active',+s.dataset.step===8));
  $('#onbBar').style.width='100%';
  const msgs=['Analyzing your strength profile…','Matching exercises to your equipment…','Balancing your weak points…','Setting rest days…','Calibrating starting weights…'];
  let mi=0;const iv=setInterval(()=>{$('#buildMsg').textContent=msgs[mi++%msgs.length];},900);

  S.program=buildLocalProgram();
  S.nutrition.plan=buildLocalMeals();

  // try Gemini for a smarter program + coach intro (optional, needs key + net)
  if(S.settings.geminiKey){
    try{const ai=await geminiProgram();if(ai)S.program.coachNote=ai;}catch(e){}
  }
  clearInterval(iv);
  S.onboarded=true;save();
  $('#buildSpinner').style.display='none';
  $('#buildTitle').textContent='You\'re all set, '+S.profile.name+'!';
  $('#buildMsg').textContent='Your program is ready.';
  setTimeout(()=>{showApp();go('home');toast('Program built 💪','good');},700);
}

/* ============================================================
   GEMINI INTEGRATION  — honest coach, not a yes-man
   ============================================================ */
const GEMINI_URL='https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=';
const COACH_PERSONA=`You are FORGE, an evidence-based strength coach. You are blunt, supportive, and grounded in exercise science (progressive overload, RPE, recovery, hypertrophy/strength rep ranges, volume landmarks). You are NOT a hype machine and NOT a yes-man. If the data says the user should LOWER a weight, deload, add a rest day, or fix a muscle imbalance, you say so directly. Keep responses tight and practical. Never invent numbers — reason from the data given.`;
async function geminiCall(prompt){
  if(!S.settings.geminiKey) throw new Error('no key');
  const r=await fetch(GEMINI_URL+S.settings.geminiKey,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({systemInstruction:{parts:[{text:COACH_PERSONA}]},contents:[{parts:[{text:prompt}]}],generationConfig:{temperature:0.7,maxOutputTokens:500}})});
  if(!r.ok)throw new Error('gemini '+r.status);
  const d=await r.json();
  return d.candidates?.[0]?.content?.parts?.[0]?.text||'';
}
async function geminiProgram(){
  const p=S.profile;
  const liftStr=Object.entries(S.lifts).map(([k,v])=>v.unknown?`${k}: never done`:`${k}: ${v.weight}lb x ${v.reps}`).join(', ')||'none given';
  const pri=(p.priority||[]).map(m=>MUSCLE_LABELS[m]).join(', ')||'none specified';
  return geminiCall(`New athlete: ${p.age}yo ${p.sex}, ${p.weight}lb, goal=${p.goal}, ${p.days} days/wk, ~${p.workoutMin}min/session, experience=${p.experience}. Current lifts: ${liftStr}. Wants to prioritize: ${pri}. Injuries: ${p.injuries||'none'}. In 2-3 sentences give honest opening coaching: name their biggest weak point and one priority. If they're a beginner, say you've started them light on purpose. Be direct.`);
}
// per-session feedback after logging — analyses real performance
async function geminiSessionFeedback(log){
  const lines=log.exercises.filter(e=>!e.warmup&&e.sets).map(e=>{
    const done=e.sets.filter(s=>s.done);
    return `${e.name}: `+done.map(s=>`${s.weight}x${s.reps}`).join(', ');
  }).join(' | ');
  // pull last time same workout was done
  const prev=S.logs.filter(l=>l.name===log.name && l!==log).slice(-1)[0];
  const prevStr=prev?prev.exercises.filter(e=>!e.warmup&&e.sets).map(e=>`${e.name}: `+e.sets.filter(s=>s.done).map(s=>`${s.weight}x${s.reps}`).join(', ')).join(' | '):'first time';
  const diff=log.difficulty?`Difficulty rated start/mid/end: ${log.difficulty.start||'?'}/${log.difficulty.mid||'?'}/${log.difficulty.end||'?'}`:'';
  return geminiCall(`Athlete (${S.profile.weight}lb, goal=${S.profile.goal}, experience=${S.profile.experience}) just finished "${log.name}".\nToday: ${lines}\nLast time: ${prevStr}\n${diff}\nAvailable dumbbells: ${(S.profile.dumbbells||[]).join(', ')||'barbell increments of 5lb'}.\nGive HONEST feedback in 2-4 short sentences: did they progress? For specific lifts, say whether to go UP, STAY, or DROP the weight next time, and only suggest weights they actually own. Flag any imbalance or overreaching. No fluff.`);
}

/* ============================================================
   MEAL PLAN (local) — bulk/cut/maintain aware
   ============================================================ */
function buildLocalMeals(){
  const m=macroTarget();const g=S.profile.goal;
  const split={breakfast:0.28,lunch:0.36,dinner:0.36};
  const ideas={
    bulk:{
      breakfast:{n:'Oats + whey + peanut butter + banana',d:'Big energy start, fast to make.'},
      lunch:{n:'Chicken, rice & avocado bowl',d:'Lean protein with carb-dense rice.'},
      dinner:{n:'Steak, potatoes & olive oil veg',d:'High calorie, high protein finish.'}
    },
    cut:{
      breakfast:{n:'Egg whites, 2 whole eggs & spinach',d:'High protein, low cal, very filling.'},
      lunch:{n:'Grilled chicken & big salad',d:'Volume eating to stay full in a deficit.'},
      dinner:{n:'White fish, broccoli & small rice',d:'Lean protein, low energy density.'}
    },
    maintain:{
      breakfast:{n:'Greek yogurt, berries & granola',d:'Balanced protein and carbs.'},
      lunch:{n:'Turkey wrap & fruit',d:'Easy, balanced, portable.'},
      dinner:{n:'Salmon, quinoa & veg',d:'Solid macros to maintain.'}
    }
  }[g];
  const meals={};
  for(const slot in split){
    const cals=Math.round(m.cals*split[slot]);
    const protein=Math.round(m.protein*split[slot]);
    const fat=Math.round(m.fat*split[slot]);
    const carbs=Math.round(m.carbs*split[slot]);
    meals[slot]={...ideas[slot],cals,protein,carbs,fat};
  }
  return {target:m,meals};
}

/* ============================================================
   NAVIGATION + APP SHELL
   ============================================================ */
function showApp(){
  $('#onb').classList.remove('active');
  $('#bottomNav').style.display='';
  $$('#bottomNav button').forEach(b=>b.onclick=()=>go(b.dataset.nav));
  go('home');
}
let current='home';
function go(nav){
  current=nav;
  $$('.screen').forEach(s=>s.classList.remove('active'));
  $('#s_'+nav).classList.add('active');
  $$('#bottomNav button').forEach(b=>b.classList.toggle('on',b.dataset.nav===nav));
  window.scrollTo(0,0);
  ({home:renderHome,workout:renderWorkout,progress:renderProgress,nutrition:renderNutrition,body:renderBody}[nav])();
}

/* ---------- MODAL ---------- */
function modal(html){$('#modalBody').innerHTML=html;$('#modal').classList.add('show');}
function closeModal(){$('#modal').classList.remove('show');stopScanner();}
$('#modal').onclick=e=>{if(e.target.id==='modal')closeModal();};

/* ============================================================
   HOME / DASHBOARD
   ============================================================ */
function todaysWorkout(){
  if(!S.program)return null;
  const ts=todayStr();
  const ov=(S.program.overrides||{})[ts];
  if(ov==='recovery')return {rest:true,recovery:true};
  if(ov==='trained')return {rest:false, alreadyDone:true};
  const dow=(new Date().getDay()+6)%7; // Mon=0
  const slot=S.program.schedule[dow];
  if(slot.type==='rest')return {rest:true};
  return {rest:false, ...S.program.split[slot.idx], idx:slot.idx};
}
// Adaptive rest: after a hard/high-volume session, flag tomorrow as recovery.
function applyAdaptiveRest(log){
  if(!S.program)return;
  S.program.overrides=S.program.overrides||{};
  const d=log.difficulty||{};
  const hardEnd = d.end==='max' || d.mid==='max';
  const ratings=[d.start,d.mid,d.end].filter(Boolean);
  const hardCount=ratings.filter(r=>r==='hard'||r==='max').length;
  // recent volume spike check
  const recent=S.logs.slice(-6).map(l=>l.volume||0).filter(v=>v>0);
  const avgVol=recent.length?recent.reduce((a,b)=>a+b,0)/recent.length:0;
  const spike = avgVol>0 && (log.volume||0) > avgVol*1.4;
  if(hardEnd || hardCount>=2 || spike){
    // mark tomorrow as a recovery day (only if it was a training day)
    const tmr=new Date();tmr.setDate(tmr.getDate()+1);
    const ts=tmr.toISOString().slice(0,10);
    const dow=(tmr.getDay()+6)%7;
    if(S.program.schedule[dow].type==='train' && !S.program.overrides[ts]){
      S.program.overrides[ts]='recovery';
      log._recoveryFlagged=true;
    }
  }
}
// If user trains on a scheduled rest day, reflow: mark today trained, give back a rest day later in week.
function reflowForOffSchedule(dateStr){
  if(!S.program)return;
  S.program.overrides=S.program.overrides||{};
  const dt=new Date(dateStr);const dow=(dt.getDay()+6)%7;
  if(S.program.schedule[dow].type==='rest'){
    S.program.overrides[dateStr]='trained';
    // find next scheduled training day this week and turn it into rest to balance
    for(let i=1;i<=6;i++){
      const nd=new Date(dt);nd.setDate(nd.getDate()+i);
      const nds=nd.toISOString().slice(0,10);
      const ndow=(nd.getDay()+6)%7;
      if(S.program.schedule[ndow].type==='train' && !S.program.overrides[nds]){
        S.program.overrides[nds]='recovery';break;
      }
    }
  }
}
function streak(){
  let s=0;const dates=new Set(S.logs.map(l=>l.date));
  let d=new Date();
  // count back from today/yesterday
  for(let i=0;i<365;i++){
    const ds=d.toISOString().slice(0,10);
    const dow=(d.getDay()+6)%7;const sched=S.program?.schedule[dow];
    if(dates.has(ds)){s++;}
    else if(sched&&sched.type==='rest'){/* rest doesn't break */}
    else if(i>0){break;}
    d.setDate(d.getDate()-1);
  }
  return s;
}
function renderHome(){
  const p=S.profile,r=overallRank(),tw=todaysWorkout();
  const bmi=calcBMI(),tdee=calcTDEE();
  const hour=new Date().getHours();
  const greet=hour<12?'Good morning':hour<18?'Good afternoon':'Good evening';
  let h=`<div class="page">
    <div class="topbar"><div><div class="sub">${greet}</div><h1>${p.name}</h1></div>
      <button onclick="openSettings()" style="width:42px;height:42px;border-radius:50%;background:var(--card2);display:flex;align-items:center;justify-content:center;border:1px solid var(--line)">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--txt2)" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      </button>
    </div>

    <div class="rank-hero">
      <div class="rank-sub">Overall Strength</div>
      <div class="rank-name">${r.tier}</div>
      <div class="rank-bar"><i style="width:${r.idx*20+r.pct*0.2}%"></i></div>
      <div class="rank-next">${r.idx<5?`<b>${round(r.idx*20+r.pct*0.2)}/100</b> · next rank: ${TIERS[r.idx+1]}`:'<b>Maxed — Elite tier</b>'}</div>
    </div>`;

  // today's workout card
  if(tw&&tw.alreadyDone){
    h+=`<div class="card" style="text-align:center;padding:24px">
      <div style="font-size:30px">✅</div>
      <div class="disp" style="font-size:22px;margin-top:6px">Today's Done</div>
      <p class="small" style="margin-top:4px">Nice work — logged for today.</p>
      <button class="btn ghost sm" style="width:100%;margin-top:14px" onclick="go('workout')">Train again</button>
    </div>`;
  } else if(tw&&!tw.rest){
    const muscles=tw.exercises?tw.exercises.filter(e=>!e.warmup).map(e=>MUSCLE_LABELS[e.muscle]).filter((v,i,a)=>a.indexOf(v)===i).slice(0,4).join(', '):'';
    h+=`<div class="card" style="border-color:var(--acc2)">
      <div class="day-pill">Today · ${tw.name}</div>
      <div style="font-size:13px;color:var(--txt2);font-weight:600;margin-bottom:14px">${tw.exercises?tw.exercises.length-1:0} exercises + warm-up · ${muscles}</div>
      <button class="btn" onclick="go('workout')">Start Workout</button>
    </div>`;
  } else if(tw&&tw.recovery){
    h+=`<div class="card" style="text-align:center;padding:26px;border-color:var(--blue)">
      <div style="font-size:30px">🛌</div>
      <div class="disp" style="font-size:22px;margin-top:6px">Recovery Day</div>
      <p class="small" style="margin-top:4px">I scheduled this after your last hard session. Let the muscles rebuild.</p>
      <button class="btn ghost sm" style="width:100%;margin-top:14px" onclick="go('workout')">Train anyway</button>
    </div>`;
  } else if(tw&&tw.rest){
    h+=`<div class="card" style="text-align:center;padding:26px">
      <div style="font-size:30px">😴</div>
      <div class="disp" style="font-size:22px;margin-top:6px">Rest Day</div>
      <p class="small" style="margin-top:4px">Recovery is where you grow. Eat, sleep, walk.</p>
      <button class="btn ghost sm" style="width:100%;margin-top:14px" onclick="go('workout')">Train anyway</button>
    </div>`;
  }

  h+=`<div class="stat-grid">
    <div class="stat"><div class="v">${streak()}<small>d</small></div><div class="l">Streak</div></div>
    <div class="stat"><div class="v">${S.logs.length}</div><div class="l">Workouts</div></div>
    <div class="stat"><div class="v">${bmi||'—'}</div><div class="l">BMI</div></div>
    <div class="stat"><div class="v">${tdee.toLocaleString()}</div><div class="l">Daily Calories</div></div>
  </div>`;

  if(S.program.coachNote){
    h+=`<div class="coach"><div class="cl">⚡ Coach</div><p>${S.program.coachNote}</p></div>`;
  }

  // muscle map preview (tappable)
  h+=`<div class="card"><div class="card-h"><div class="t">Muscle Strength</div><button class="small" style="color:var(--acc);font-weight:700" onclick="go('progress')">Details →</button></div>
    ${muscleMapSVG()}
    <p class="small" style="text-align:center;margin-top:4px">Tap a muscle to see your level</p>
    <div class="mlegend"><span><i style="background:#2a2a30"></i>Weak</span><span><i style="background:var(--blue)"></i>Developing</span><span><i style="background:var(--green)"></i>Strong</span><span><i style="background:var(--acc)"></i>Elite</span></div>
  </div>`;
  h+=`</div>`;
  $('#s_home').innerHTML=h;
}
function muscleInfo(m){
  const lvl=(muscleStrength()[m]||0); // 0..5
  const tier=TIERS[Math.min(5,Math.round(lvl))]||'Untrained';
  const desc=lvl<=0?'No data yet — log lifts that train this muscle and I\'ll rank it.'
    :lvl<1.5?'Underdeveloped relative to your bodyweight. Lots of room to grow.'
    :lvl<2.8?'Developing nicely. Keep adding load and volume.'
    :lvl<4?'Strong for your bodyweight. Solid base here.'
    :'Elite-level strength for your bodyweight. Maintain and refine.';
  modal(`<h3>${MUSCLE_LABELS[m]||m}</h3>
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
      <span class="tier tier-${tier}" style="font-size:12px;font-weight:800;padding:4px 11px;border-radius:20px">${tier}</span>
      <div class="rank-bar" style="flex:1;margin:0"><i style="width:${Math.min(100,lvl*20)}%"></i></div>
    </div>
    <p style="color:var(--txt2);line-height:1.55">${desc}</p>
    <button class="btn ghost" style="margin-top:16px" onclick="closeModal()">Got it</button>`);
}

/* ---------- MUSCLE MAP SVG (front body, colored by strength) ---------- */
function muscColor(v){ // v 0..5
  if(v<=0)return '#2a2a30';
  if(v<1.5)return '#3a4a5a';
  if(v<2.8)return 'var(--blue)';
  if(v<4)return 'var(--green)';
  return 'var(--acc)';
}
function muscleMapSVG(){
  const ms=muscleStrength();
  const c=m=>muscColor(ms[m]||0);
  const tap=m=>`onclick="muscleInfo('${m}')" style="cursor:pointer"`;
  return `<div class="mmap"><svg viewBox="0 0 120 240" xmlns="http://www.w3.org/2000/svg">
    <circle cx="60" cy="20" r="13" fill="#2a2a30"/>
    <path d="M40 36 Q60 30 80 36 L78 46 Q60 40 42 46 Z" fill="${c('traps')}" ${tap('traps')}/>
    <circle cx="36" cy="52" r="11" fill="${c('frontDelt')}" ${tap('frontDelt')}/>
    <circle cx="84" cy="52" r="11" fill="${c('frontDelt')}" ${tap('frontDelt')}/>
    <path d="M44 48 Q60 44 76 48 L74 74 Q60 80 46 74 Z" fill="${c('chest')}" ${tap('chest')}/>
    <rect x="50" y="78" width="20" height="34" rx="5" fill="${c('abs')}" ${tap('abs')}/>
    <rect x="26" y="60" width="11" height="30" rx="5" fill="${c('biceps')}" ${tap('biceps')}/>
    <rect x="83" y="60" width="11" height="30" rx="5" fill="${c('biceps')}" ${tap('biceps')}/>
    <rect x="24" y="90" width="9" height="28" rx="4" fill="${c('forearms')}" ${tap('forearms')}/>
    <rect x="87" y="90" width="9" height="28" rx="4" fill="${c('forearms')}" ${tap('forearms')}/>
    <rect x="46" y="116" width="13" height="48" rx="6" fill="${c('quads')}" ${tap('quads')}/>
    <rect x="61" y="116" width="13" height="48" rx="6" fill="${c('quads')}" ${tap('quads')}/>
    <rect x="47" y="170" width="11" height="40" rx="5" fill="${c('calves')}" ${tap('calves')}/>
    <rect x="62" y="170" width="11" height="40" rx="5" fill="${c('calves')}" ${tap('calves')}/>
  </svg></div>`;
}

/* ============================================================
   WORKOUT  (today's session + logging)
   ============================================================ */
let rest={timer:null,left:0};
function renderWorkout(){
  const tw=todaysWorkout();
  let workout=tw&&!tw.rest?tw:null;
  // if active session exists, resume it; else allow choosing day
  if(S.active){return renderActiveSession();}
  let h=`<div class="page"><div class="topbar"><div><div class="sub">Training</div><h1>Workout</h1></div></div>`;

  // day selector
  h+=`<div class="tabs" id="dayTabs">`;
  S.program.split.forEach((d,i)=>{h+=`<button class="${workout&&workout.idx===i?'on':''}" onclick="previewDay(${i})">${d.name}</button>`;});
  h+=`</div><div id="dayPreview"></div></div>`;
  $('#s_workout').innerHTML=h;
  previewDay(workout?workout.idx:0);
}
function previewDay(idx){
  $$('#dayTabs button').forEach((b,i)=>b.classList.toggle('on',i===idx));
  const d=S.program.split[idx];
  const fav=S.favorites.includes(d.name);
  const workCount=d.exercises.filter(e=>!e.warmup).length;
  let h=`<div class="card" style="border-color:var(--acc2)">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <div class="disp" style="font-size:24px">${d.name}</div>
      <button onclick="toggleFav('${d.name}')" style="font-size:22px">${fav?'★':'☆'}</button>
    </div>
    <p class="small" style="margin:4px 0 14px">Warm-up + ${workCount} exercises · ~${S.program.workoutMin||60} min</p>
    <button class="btn" onclick="startSession(${idx})">Start This Workout</button>
  </div>`;
  d.exercises.forEach(e=>{
    if(e.warmup){
      h+=`<div class="ex-card" style="border-color:var(--acc2)"><div class="ex-head">
        <div><div class="nm">🔥 ${e.name}</div><div class="meta">~8 min · primes the joints</div></div>
        <span class="ex-musc">Warm-up</span></div></div>`;
      return;
    }
    const loadStr=e.weight!=null?`start ${e.weight}lb`:'bodyweight / your load';
    h+=`<div class="ex-card"><div class="ex-head">
      <div><div class="nm">${e.name}${e.priority?' <span style="color:var(--acc);font-size:12px">★ priority</span>':''}</div><div class="meta">${e.sets} sets · ${e.reps} reps · ${loadStr}</div></div>
      <button class="ex-musc" onclick="showForm('${e.name.replace(/'/g,"")}','${e.muscle}')">${MUSCLE_LABELS[e.muscle]}</button>
    </div></div>`;
  });
  $('#dayPreview').innerHTML=h;
}
function toggleFav(name){const i=S.favorites.indexOf(name);if(i>=0)S.favorites.splice(i,1);else S.favorites.push(name);save();previewDay(S.program.split.findIndex(d=>d.name===name));toast(i>=0?'Removed favorite':'Added to favorites ★');}

function showForm(name,muscle){
  const ex=Object.values(EXLIB).flat().find(x=>x.n===name);
  modal(`<h3>${name}</h3>
    <div style="background:var(--bg3);border-radius:14px;padding:18px;text-align:center;margin-bottom:14px">
      ${formAnimation(name)}
      <p class="small" style="margin-top:6px">Animated form guide</p>
    </div>
    <div style="display:flex;gap:8px;margin-bottom:12px"><span class="ex-musc">${MUSCLE_LABELS[muscle]}</span></div>
    <p style="color:var(--txt);line-height:1.6">${ex?ex.c:'Controlled reps, full range of motion, brace your core.'}</p>
    <button class="btn ghost" style="margin-top:18px" onclick="closeModal()">Got it</button>`);
}
function movementPattern(name){
  const n=(name||'').toLowerCase();
  if(/overhead press|shoulder press|arnold|military|ohp/.test(n))return 'press_v';
  if(/bench|push-up|pushup|chest press|dumbbell press|incline|close-grip/.test(n))return 'press_h';
  if(/leg curl|nordic/.test(n))return 'legcurl';
  if(/squat|leg press/.test(n))return 'squat';
  if(/deadlift|rdl|romanian|hip thrust|good morning|hinge|bridge/.test(n))return 'hinge';
  if(/lunge|split squat/.test(n))return 'lunge';
  if(/lateral|reverse fly|face pull|upright/.test(n))return 'lateral';
  if(/\bfly\b|crossover/.test(n))return 'fly';
  if(/pulldown|pull-up|pullup|chin/.test(n))return 'pulldown';
  if(/\brow\b/.test(n))return 'row';
  if(/curl/.test(n))return 'curl';
  if(/pushdown|tricep|skull|extension|\bdip/.test(n))return 'pushdown';
  if(/calf/.test(n))return 'calf';
  if(/plank|crunch|leg raise|hollow|bicycle|carry|wrist/.test(n))return 'core';
  return 'generic';
}
function formAnimation(name){
  const pat=movementPattern(name);
  const SP='dur="2.2s" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.5;1" keySplines="0.4 0 0.2 1;0.4 0 0.2 1"';
  const open='<svg viewBox="0 0 140 152" style="width:124px;height:134px">';
  const ground='<line x1="28" y1="148" x2="112" y2="148" stroke="var(--line)" stroke-width="2"/>';
  const close='</svg>';
  const body='var(--txt2)', acc='var(--acc)';
  // reusable bar (centered horizontally at given y, width w)
  const bar=(y,w=70)=>{const x=70-w/2;return `<rect x="${x}" y="${y}" width="${w}" height="6" rx="3" fill="${acc}"/><rect x="${x-2}" y="${y-6}" width="6" height="18" rx="2" fill="${acc}"/><rect x="${x+w-4}" y="${y-6}" width="6" height="18" rx="2" fill="${acc}"/>`;};

  switch(pat){
    case 'press_v': return open+ground+
      `<rect x="62" y="96" width="7" height="50" rx="3" fill="${body}"/><rect x="71" y="96" width="7" height="50" rx="3" fill="${body}"/>
       <rect x="61" y="56" width="18" height="42" rx="7" fill="${body}"/><circle cx="70" cy="45" r="11" fill="${body}"/>
       <g><animateTransform attributeName="transform" type="translate" values="0 0;0 -30;0 0" ${SP}/>
         <rect x="50" y="54" width="7" height="20" rx="3" fill="${body}" transform="rotate(18 53 56)"/>
         <rect x="83" y="54" width="7" height="20" rx="3" fill="${body}" transform="rotate(-18 87 56)"/>
         ${bar(50,64)}</g>`+close;

    case 'press_h': return open+
      `<line x1="30" y1="104" x2="112" y2="104" stroke="var(--line)" stroke-width="3"/>
       <rect x="44" y="92" width="56" height="12" rx="4" fill="var(--bg)" stroke="var(--line)" stroke-width="1.5"/>
       <circle cx="42" cy="86" r="10" fill="${body}"/>
       <rect x="50" y="84" width="44" height="14" rx="7" fill="${body}"/>
       <rect x="92" y="86" width="20" height="9" rx="4" fill="${body}"/>
       <g><animateTransform attributeName="transform" type="translate" values="0 0;0 -28;0 0" ${SP}/>
         <rect x="64" y="62" width="7" height="26" rx="3" fill="${body}"/>
         ${bar(56,52)}</g>`+close;

    case 'squat': return open+ground+
      `<g><animateTransform attributeName="transform" type="translate" values="0 0;0 20;0 0" ${SP}/>
         <circle cx="70" cy="40" r="11" fill="${body}"/>
         <rect x="61" y="50" width="18" height="38" rx="7" fill="${body}"/>
         ${bar(48,58)}</g>
       <rect x="58" y="84" width="9" height="34" rx="4" fill="${body}"><animateTransform attributeName="transform" type="rotate" values="0 62 86;-14 62 86;0 62 86" ${SP}/></rect>
       <rect x="73" y="84" width="9" height="34" rx="4" fill="${body}"><animateTransform attributeName="transform" type="rotate" values="0 78 86;14 78 86;0 78 86" ${SP}/></rect>
       <rect x="55" y="116" width="11" height="32" rx="4" fill="${body}"/><rect x="74" y="116" width="11" height="32" rx="4" fill="${body}"/>`+close;

    case 'hinge': return open+ground+
      `<rect x="62" y="92" width="8" height="56" rx="4" fill="${body}"/><rect x="71" y="92" width="8" height="56" rx="4" fill="${body}"/>
       <g><animateTransform attributeName="transform" type="rotate" values="0 70 94;62 70 94;0 70 94" ${SP}/>
         <rect x="62" y="52" width="16" height="44" rx="7" fill="${body}"/><circle cx="70" cy="42" r="11" fill="${body}"/>
         <rect x="66" y="92" width="7" height="34" rx="3" fill="${body}"/>
         ${bar(120,46)}</g>`+close;

    case 'row': return open+ground+
      `<rect x="40" y="120" width="46" height="6" rx="3" fill="${body}" transform="rotate(8 63 123)"/>
       <rect x="78" y="96" width="8" height="52" rx="4" fill="${body}" transform="rotate(6 82 122)"/>
       <g transform="rotate(58 80 60)">
         <rect x="72" y="52" width="16" height="42" rx="7" fill="${body}"/><circle cx="80" cy="42" r="11" fill="${body}"/></g>
       <g><animateTransform attributeName="transform" type="translate" values="0 0;0 -22;0 0" ${SP}/>
         <rect x="60" y="78" width="7" height="34" rx="3" fill="${body}"/>
         ${bar(108,40)}</g>`+close;

    case 'pulldown': return open+
      `<rect x="62" y="92" width="8" height="40" rx="4" fill="${body}"/><rect x="71" y="92" width="8" height="40" rx="4" fill="${body}"/>
       <rect x="58" y="130" width="26" height="6" rx="3" fill="var(--line)"/>
       <rect x="61" y="58" width="18" height="40" rx="7" fill="${body}"/><circle cx="70" cy="46" r="11" fill="${body}"/>
       <g><animateTransform attributeName="transform" type="translate" values="0 0;0 28;0 0" ${SP}/>
         <rect x="50" y="40" width="7" height="22" rx="3" fill="${body}" transform="rotate(12 53 60)"/>
         <rect x="83" y="40" width="7" height="22" rx="3" fill="${body}" transform="rotate(-12 87 60)"/>
         ${bar(30,66)}</g>`+close;

    case 'curl': return open+ground+
      `<rect x="62" y="94" width="7" height="52" rx="3" fill="${body}"/><rect x="71" y="94" width="7" height="52" rx="3" fill="${body}"/>
       <rect x="61" y="52" width="18" height="44" rx="7" fill="${body}"/><circle cx="70" cy="42" r="11" fill="${body}"/>
       <rect x="52" y="58" width="7" height="22" rx="3" fill="${body}"/><rect x="81" y="58" width="7" height="22" rx="3" fill="${body}"/>
       <g><animateTransform attributeName="transform" type="rotate" values="0 55 78;-128 55 78;0 55 78" ${SP}/>
         <rect x="52" y="78" width="7" height="26" rx="3" fill="${body}"/><rect x="47" y="100" width="17" height="9" rx="4" fill="${acc}"/></g>
       <g><animateTransform attributeName="transform" type="rotate" values="0 85 78;128 85 78;0 85 78" ${SP}/>
         <rect x="81" y="78" width="7" height="26" rx="3" fill="${body}"/><rect x="76" y="100" width="17" height="9" rx="4" fill="${acc}"/></g>`+close;

    case 'lateral': return open+ground+
      `<rect x="62" y="94" width="7" height="52" rx="3" fill="${body}"/><rect x="71" y="94" width="7" height="52" rx="3" fill="${body}"/>
       <rect x="61" y="52" width="18" height="44" rx="7" fill="${body}"/><circle cx="70" cy="42" r="11" fill="${body}"/>
       <g><animateTransform attributeName="transform" type="rotate" values="0 60 58;-95 60 58;0 60 58" ${SP}/>
         <rect x="40" y="56" width="22" height="7" rx="3" fill="${body}"/><rect x="34" y="52" width="10" height="15" rx="3" fill="${acc}"/></g>
       <g><animateTransform attributeName="transform" type="rotate" values="0 80 58;95 80 58;0 80 58" ${SP}/>
         <rect x="78" y="56" width="22" height="7" rx="3" fill="${body}"/><rect x="96" y="52" width="10" height="15" rx="3" fill="${acc}"/></g>`+close;

    case 'fly': return open+ground+
      `<rect x="62" y="94" width="7" height="52" rx="3" fill="${body}"/><rect x="71" y="94" width="7" height="52" rx="3" fill="${body}"/>
       <rect x="61" y="52" width="18" height="44" rx="7" fill="${body}"/><circle cx="70" cy="42" r="11" fill="${body}"/>
       <g><animateTransform attributeName="transform" type="rotate" values="-70 62 58;-15 62 58;-70 62 58" ${SP}/>
         <rect x="34" y="55" width="28" height="7" rx="3" fill="${body}"/><rect x="30" y="51" width="9" height="15" rx="3" fill="${acc}"/></g>
       <g><animateTransform attributeName="transform" type="rotate" values="70 78 58;15 78 58;70 78 58" ${SP}/>
         <rect x="78" y="55" width="28" height="7" rx="3" fill="${body}"/><rect x="101" y="51" width="9" height="15" rx="3" fill="${acc}"/></g>`+close;

    case 'pushdown': return open+ground+
      `<rect x="62" y="94" width="7" height="52" rx="3" fill="${body}"/><rect x="71" y="94" width="7" height="52" rx="3" fill="${body}"/>
       <rect x="61" y="52" width="18" height="44" rx="7" fill="${body}"/><circle cx="70" cy="42" r="11" fill="${body}"/>
       <rect x="52" y="56" width="7" height="24" rx="3" fill="${body}"/><rect x="81" y="56" width="7" height="24" rx="3" fill="${body}"/>
       <g><animateTransform attributeName="transform" type="rotate" values="-78 55 78;0 55 78;-78 55 78" ${SP}/>
         <rect x="52" y="78" width="7" height="26" rx="3" fill="${body}"/></g>
       <g><animateTransform attributeName="transform" type="rotate" values="78 85 78;0 85 78;78 85 78" ${SP}/>
         <rect x="81" y="78" width="7" height="26" rx="3" fill="${body}"/></g>
       <rect x="48" y="100" width="44" height="6" rx="3" fill="${acc}"><animateTransform attributeName="transform" type="translate" values="0 -22;0 0;0 -22" ${SP}/></rect>`+close;

    case 'lunge': return open+ground+
      `<g><animateTransform attributeName="transform" type="translate" values="0 0;0 16;0 0" ${SP}/>
         <circle cx="66" cy="44" r="11" fill="${body}"/><rect x="57" y="54" width="18" height="40" rx="7" fill="${body}"/></g>
       <rect x="48" y="90" width="9" height="32" rx="4" fill="${body}" transform="rotate(28 52 92)"/>
       <rect x="40" y="118" width="9" height="30" rx="4" fill="${body}"/>
       <rect x="74" y="90" width="9" height="30" rx="4" fill="${body}" transform="rotate(-22 78 92)"/>
       <rect x="86" y="116" width="9" height="32" rx="4" fill="${body}"/>`+close;

    case 'calf': return open+ground+
      `<g><animateTransform attributeName="transform" type="translate" values="0 0;0 -12;0 0" dur="1.4s" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.5;1" keySplines="0.4 0 0.2 1;0.4 0 0.2 1"/>
         <circle cx="70" cy="40" r="11" fill="${body}"/><rect x="61" y="50" width="18" height="40" rx="7" fill="${body}"/>
         <rect x="50" y="54" width="7" height="30" rx="3" fill="${body}"/><rect x="83" y="54" width="7" height="30" rx="3" fill="${body}"/>
         <rect x="58" y="88" width="9" height="40" rx="4" fill="${body}"/><rect x="73" y="88" width="9" height="40" rx="4" fill="${body}"/>
         <rect x="54" y="126" width="16" height="6" rx="3" fill="${acc}"/><rect x="70" y="126" width="16" height="6" rx="3" fill="${acc}"/></g>`+close;

    case 'legcurl': return open+
      `<line x1="28" y1="96" x2="112" y2="96" stroke="var(--line)" stroke-width="3"/>
       <circle cx="40" cy="86" r="9" fill="${body}"/><rect x="40" y="84" width="50" height="13" rx="6" fill="${body}"/>
       <g><animateTransform attributeName="transform" type="rotate" values="0 90 92;-95 90 92;0 90 92" ${SP}/>
         <rect x="86" y="84" width="30" height="9" rx="4" fill="${body}"/><rect x="110" y="80" width="10" height="16" rx="4" fill="${acc}"/></g>`+close;

    case 'core': return open+
      `<line x1="30" y1="120" x2="112" y2="120" stroke="var(--line)" stroke-width="3"/>
       <rect x="58" y="108" width="40" height="10" rx="4" fill="${body}"/>
       <g><animateTransform attributeName="transform" type="rotate" values="0 56 112;-38 56 112;0 56 112" ${SP}/>
         <rect x="52" y="92" width="14" height="22" rx="6" fill="${body}"/><circle cx="48" cy="86" r="9" fill="${body}"/></g>
       <rect x="92" y="100" width="22" height="8" rx="4" fill="${body}" transform="rotate(-30 96 112)"/>`+close;

    default: return open+ground+
      `<circle cx="70" cy="40" r="11" fill="${acc}"/><rect x="61" y="50" width="18" height="44" rx="7" fill="${body}"/>
       <rect x="44" y="56" width="22" height="6" rx="3" fill="${acc}"><animateTransform attributeName="transform" type="rotate" values="0 66 58;-30 66 58;0 66 58" dur="1.8s" repeatCount="indefinite"/></rect>
       <rect x="74" y="56" width="22" height="6" rx="3" fill="${acc}"><animateTransform attributeName="transform" type="rotate" values="0 74 58;30 74 58;0 74 58" dur="1.8s" repeatCount="indefinite"/></rect>
       <rect x="58" y="92" width="9" height="40" rx="4" fill="${body}"/><rect x="73" y="92" width="9" height="40" rx="4" fill="${body}"/>`+close;
  }
}

/* ---------- ACTIVE SESSION ---------- */
function startSession(idx){
  const d=S.program.split[idx];
  S.active={name:d.name,idx,date:todayStr(),started:Date.now(),
    exercises:d.exercises.map(e=>e.warmup
      ? {name:e.name,muscle:'warmup',cue:e.cue,warmup:true,items:e.items,done:false}
      : {name:e.name,muscle:e.muscle,cue:e.cue,rest:e.rest,target:e.reps,
         sets:Array.from({length:e.sets},()=>({weight:e.weight,reps:'',type:'normal',done:false}))}),
    difficulty:{start:null,mid:null,end:null}};
  save();renderActiveSession();
}
function renderActiveSession(){
  const a=S.active;
  let h=`<div class="page"><div class="topbar">
    <div><div class="sub">In Progress</div><h1>${a.name}</h1></div>
    <button class="btn ghost sm" onclick="cancelSession()" style="padding:9px 14px">Quit</button></div>`;

  // difficulty: start
  h+=diffPicker('start','How do you feel starting?');

  a.exercises.forEach((e,ei)=>{
    if(e.warmup){
      h+=`<div class="ex-card" style="border-color:var(--acc2)">
        <div class="ex-head"><div><div class="nm">🔥 ${e.name}</div><div class="meta">Prime the joints — ~8 min</div></div>
        <button class="set-done ${e.done?'on':''}" onclick="toggleWarmup(${ei})"><svg viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7"/></svg></button></div>
        <div style="padding:4px 16px 14px">${e.items.map(it=>`<div style="display:flex;gap:8px;padding:5px 0;font-size:13px;color:var(--txt2)"><span style="color:var(--acc)">•</span>${it}</div>`).join('')}</div>
      </div>`;
      return;
    }
    h+=`<div class="ex-card">
      <div class="ex-head"><div><div class="nm">${e.name}</div><div class="meta">target ${e.target} reps</div></div>
      <button class="ex-musc" onclick="showForm('${e.name.replace(/'/g,"")}','${e.muscle}')">${MUSCLE_LABELS[e.muscle]}</button></div>`;
    e.sets.forEach((s,si)=>{
      h+=`<div class="set-row">
        <div class="si">${si+1}</div>
        <input class="set-inp" inputmode="decimal" value="${s.weight||''}" placeholder="lb" onchange="setVal(${ei},${si},'weight',this.value)">
        <span class="set-x">×</span>
        <input class="set-inp" inputmode="numeric" value="${s.reps||''}" placeholder="reps" onchange="setVal(${ei},${si},'reps',this.value)">
        <button class="set-tag" onclick="cycleType(${ei},${si})">${s.type==='normal'?'SET':s.type.toUpperCase()}</button>
        <button class="set-done ${s.done?'on':''}" onclick="toggleSet(${ei},${si})"><svg viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7"/></svg></button>
      </div>`;
    });
    h+=`<button class="addset" onclick="addSet(${ei})">+ Add Set</button></div>`;
  });

  h+=diffPicker('mid','Mid-workout check');
  h+=diffPicker('end','How was the finish?');
  h+=`<button class="btn" style="margin-top:8px" onclick="finishSession()">Finish & Save Workout</button></div>`;
  $('#s_workout').innerHTML=h;
}
function toggleWarmup(ei){const e=S.active.exercises[ei];e.done=!e.done;save();if(e.done)vibrate(20);renderActiveSession();}
function diffPicker(key,label){
  const opts=[['easy','Easy'],['moderate','Moderate'],['hard','Hard'],['max','Destroyed me']];
  const cur=S.active.difficulty[key];
  return `<div class="card" style="padding:14px"><div class="t" style="font-size:11px;margin-bottom:10px;color:var(--txt2);font-weight:800;text-transform:uppercase;letter-spacing:1px">${label}</div>
    <div class="chips">${opts.map(o=>`<button class="chip ${cur===o[0]?'on':''}" style="font-size:12px;padding:9px 6px" onclick="setDiff('${key}','${o[0]}')">${o[1]}</button>`).join('')}</div></div>`;
}
function setDiff(k,v){S.active.difficulty[k]=v;save();renderActiveSession();}
function setVal(ei,si,f,v){S.active.exercises[ei].sets[si][f]=v;save();}
function cycleType(ei,si){const t=['normal','warmup','drop','failure','superset'];const s=S.active.exercises[ei].sets[si];s.type=t[(t.indexOf(s.type)+1)%t.length];save();renderActiveSession();}
function addSet(ei){const sets=S.active.exercises[ei].sets;sets.push({weight:sets[sets.length-1]?.weight||'',reps:'',type:'normal',done:false});save();renderActiveSession();}
function toggleSet(ei,si){
  const s=S.active.exercises[ei].sets[si];s.done=!s.done;save();
  if(s.done){vibrate(30);startRest(S.active.exercises[ei].rest||90);}
  renderActiveSession();
}
function cancelSession(){modal(`<h3>Quit workout?</h3><p style="color:var(--txt2);margin-bottom:18px">Your progress this session won't be saved.</p>
  <button class="btn" style="background:var(--red);color:#fff" onclick="S.active=null;save();closeModal();renderWorkout()">Quit</button>
  <button class="btn ghost" style="margin-top:10px" onclick="closeModal()">Keep going</button>`);}

/* ---------- REST TIMER ---------- */
function startRest(sec){
  rest.left=sec;$('#restTimer').classList.add('show');updateRest();
  clearInterval(rest.timer);
  rest.timer=setInterval(()=>{rest.left--;updateRest();
    if(rest.left<=0){clearInterval(rest.timer);$('#restTimer').classList.remove('show');vibrate([100,50,100]);notify('Rest complete','Time for your next set 💪');}},1000);
}
function updateRest(){const m=Math.floor(rest.left/60),s=rest.left%60;$('#rtTime').textContent=`${m}:${s.toString().padStart(2,'0')}`;}
function addRest(n){rest.left+=n;updateRest();}
function skipRest(){clearInterval(rest.timer);$('#restTimer').classList.remove('show');}

/* ---------- FINISH SESSION → log, PRs, AI feedback ---------- */
async function finishSession(){
  const a=S.active;
  const anyDone=a.exercises.some(e=>!e.warmup&&e.sets&&e.sets.some(s=>s.done&&s.reps));
  if(!anyDone){toast('Log at least one set first','bad');return;}
  // detect PRs
  const newPRs=[];
  a.exercises.forEach(e=>{
    if(e.warmup||!e.sets)return;
    e.sets.filter(s=>s.done&&s.weight&&s.reps).forEach(s=>{
      const orm=epley1RM(+s.weight,+s.reps);
      if(!S.prs[e.name]||orm>S.prs[e.name].orm){
        S.prs[e.name]={orm,weight:+s.weight,reps:+s.reps,date:a.date};
        if(S.logs.length>0)newPRs.push(e.name);
      }
    });
  });
  // update assessed lifts if matching
  a.exercises.forEach(e=>{
    if(e.warmup||!e.sets)return;
    const best=e.sets.filter(s=>s.done&&s.weight&&s.reps).sort((x,y)=>epley1RM(+y.weight,+y.reps)-epley1RM(+x.weight,+x.reps))[0];
    if(best){const match=Object.keys(STD).find(k=>e.name.includes(k.replace(' (bw+)','')));if(match)S.lifts[match]={weight:+best.weight,reps:+best.reps};}
  });
  a.duration=Math.round((Date.now()-a.started)/60000);
  a.volume=a.exercises.reduce((t,e)=>t+((e.warmup||!e.sets)?0:e.sets.filter(s=>s.done).reduce((v,s)=>v+(+s.weight||0)*(+s.reps||0),0)),0);
  S.logs.push(JSON.parse(JSON.stringify(a)));
  const finishedLog=S.logs[S.logs.length-1];

  // adaptive scheduling: reflow if trained on a rest day, flag recovery if brutal
  reflowForOffSchedule(finishedLog.date);
  applyAdaptiveRest(finishedLog);

  S.active=null;save();

  // celebrate PRs
  if(newPRs.length)setTimeout(()=>toast('🏆 New PR: '+newPRs[0]+(newPRs.length>1?` +${newPRs.length-1} more`:''),'good'),400);

  go('home');toast('Workout saved!','good');

  // if we flagged a recovery day, let them know
  if(finishedLog._recoveryFlagged){
    setTimeout(()=>toast('Hard session logged — I set tomorrow as recovery 🛌','good'),1400);
  }

  // AI feedback if online + key
  if(S.settings.geminiKey&&navigator.onLine){
    toast('Coach is reviewing…');
    try{const fb=await geminiSessionFeedback(finishedLog);
      if(fb){finishedLog.coachFeedback=fb;save();
        modal(`<h3>⚡ Coach Feedback</h3><div class="coach" style="margin:0"><p>${fb}</p></div><button class="btn ghost" style="margin-top:16px" onclick="closeModal()">Got it</button>`);}
    }catch(e){/* offline / no key — fine */}
  }
}

/* ============================================================
   PROGRESS / STATS
   ============================================================ */
let progTab='ranks';
function renderProgress(){
  let h=`<div class="page"><div class="topbar"><div><div class="sub">Your numbers</div><h1>Stats</h1></div></div>
    <div class="tabs">
      <button class="${progTab==='ranks'?'on':''}" onclick="setProgTab('ranks')">Strength Ranks</button>
      <button class="${progTab==='calendar'?'on':''}" onclick="setProgTab('calendar')">Calendar</button>
      <button class="${progTab==='prs'?'on':''}" onclick="setProgTab('prs')">Records</button>
      <button class="${progTab==='graphs'?'on':''}" onclick="setProgTab('graphs')">Progress</button>
    </div><div id="progBody"></div></div>`;
  $('#s_progress').innerHTML=h;
  renderProgTab();
}
function setProgTab(t){progTab=t;renderProgTab();$$('#s_progress .tabs button').forEach(b=>b.classList.toggle('on',b.textContent.toLowerCase().includes(t==='ranks'?'rank':t==='prs'?'record':t)));}
function renderProgTab(){
  const b=$('#progBody');
  if(progTab==='ranks')b.innerHTML=ranksView();
  else if(progTab==='calendar')b.innerHTML=calendarView();
  else if(progTab==='prs')b.innerHTML=prsView();
  else b.innerHTML=graphsView();
}
function ranksView(){
  let h=`<div class="card"><div class="card-h"><div class="t">Muscle Map</div></div>${muscleMapSVG()}
    <div class="mlegend"><span><i style="background:#2a2a30"></i>Weak</span><span><i style="background:var(--blue)"></i>Developing</span><span><i style="background:var(--green)"></i>Strong</span><span><i style="background:var(--acc)"></i>Elite</span></div></div>`;
  h+=`<div class="card"><div class="card-h"><div class="t">Lift Rankings</div></div>`;
  let any=false;
  for(const k in S.lifts){const l=S.lifts[k];if(!l||!l.weight)continue;any=true;
    const orm=epley1RM(+l.weight,+l.reps);const r=rankLift(k,orm);if(!r)continue;
    h+=`<div style="padding:14px 0;border-bottom:1px solid var(--line)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <b style="font-size:15px">${k}</b><span class="tier tier-${r.tier}" style="font-size:11px;font-weight:800;padding:3px 9px;border-radius:20px">${r.tier}</span></div>
      <div class="rank-bar" style="margin-top:0"><i style="width:${r.idx*20+r.pct*0.2}%"></i></div>
      <div class="small" style="margin-top:6px">Est. 1RM <b style="color:var(--txt)">${orm}lb</b>${r.nextW?` · ${r.nextW}lb for ${r.nextTier}`:' · maxed'}</div>
    </div>`;
  }
  if(!any)h+=`<p class="small">Log some workouts and your ranks will fill in.</p>`;
  h+=`</div>`;
  return h;
}

/* ---------- CALENDAR ---------- */
let calMonth=new Date().getMonth(),calYear=new Date().getFullYear();
function calendarView(){
  const first=new Date(calYear,calMonth,1),days=new Date(calYear,calMonth+1,0).getDate();
  const startDow=(first.getDay()+6)%7;
  const logDates={};S.logs.forEach(l=>logDates[l.date]=l);
  const mn=first.toLocaleString('default',{month:'long',year:'numeric'});
  let h=`<div class="card"><div class="cal-head">
    <button onclick="calNav(-1)" style="font-size:22px;color:var(--txt2);padding:0 8px">‹</button>
    <div class="m">${mn}</div>
    <button onclick="calNav(1)" style="font-size:22px;color:var(--txt2);padding:0 8px">›</button></div>
    <div class="cal-grid">`;
  ['M','T','W','T','F','S','S'].forEach(d=>h+=`<div class="cal-dow">${d}</div>`);
  for(let i=0;i<startDow;i++)h+=`<div class="cal-day empty"></div>`;
  const ts=todayStr();
  for(let d=1;d<=days;d++){
    const ds=`${calYear}-${String(calMonth+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const dt=new Date(calYear,calMonth,d);const dow=(dt.getDay()+6)%7;
    const sched=S.program?.schedule[dow];
    let cls='cal-day';const isPast=ds<ts;
    if(logDates[ds])cls+=' trained';
    else if(sched&&sched.type==='rest')cls+=' rest';
    else if(isPast&&sched&&sched.type==='train')cls+=' missed';
    if(ds===ts)cls+=' today';
    h+=`<div class="${cls}" onclick="dayDetail('${ds}')">${d}${logDates[ds]?'<span class="dot"></span>':''}</div>`;
  }
  h+=`</div></div>
    <div class="row" style="margin-bottom:14px">
      <div class="stat"><div class="v">${S.logs.filter(l=>l.date.startsWith(`${calYear}-${String(calMonth+1).padStart(2,'0')}`)).length}</div><div class="l">This month</div></div>
      <div class="stat"><div class="v">${streak()}<small>d</small></div><div class="l">Streak</div></div>
    </div>`;
  return h;
}
function calNav(n){calMonth+=n;if(calMonth<0){calMonth=11;calYear--;}if(calMonth>11){calMonth=0;calYear++;}renderProgTab();}
function dayDetail(ds){
  const l=S.logs.find(x=>x.date===ds);
  if(!l){const dt=new Date(ds);const dow=(dt.getDay()+6)%7;const sched=S.program?.schedule[dow];
    modal(`<h3>${new Date(ds).toLocaleDateString('default',{weekday:'long',month:'short',day:'numeric'})}</h3>
    <p style="color:var(--txt2)">${sched&&sched.type==='rest'?'Scheduled rest day. 😴':ds<todayStr()?'No workout logged. ':'Nothing scheduled yet.'}</p>
    <button class="btn ghost" style="margin-top:16px" onclick="closeModal()">Close</button>`);return;}
  let h=`<h3>${l.name}</h3><p class="small" style="margin-bottom:14px">${new Date(ds).toLocaleDateString('default',{weekday:'long',month:'short',day:'numeric'})} · ${l.duration||'—'} min · ${round(l.volume||0)}lb volume</p>`;
  l.exercises.forEach(e=>{if(e.warmup||!e.sets)return;const done=e.sets.filter(s=>s.done&&s.reps);if(!done.length)return;
    h+=`<div style="margin-bottom:12px"><b>${e.name}</b> <span class="ex-musc">${MUSCLE_LABELS[e.muscle]}</span>
      <div class="small" style="margin-top:4px">${done.map(s=>`${s.weight}×${s.reps}`).join('  ·  ')}</div></div>`;});
  if(l.difficulty){h+=`<div class="small" style="margin-top:8px">Felt: ${l.difficulty.start||'?'} → ${l.difficulty.mid||'?'} → ${l.difficulty.end||'?'}</div>`;}
  if(l.coachFeedback)h+=`<div class="coach" style="margin-top:14px"><div class="cl">⚡ Coach</div><p>${l.coachFeedback}</p></div>`;
  h+=`<button class="btn ghost" style="margin-top:16px" onclick="closeModal()">Close</button>`;
  modal(h);
}

/* ---------- PRs / records ---------- */
function prsView(){
  const prs=Object.entries(S.prs).sort((a,b)=>b[1].orm-a[1].orm);
  if(!prs.length)return`<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 9H4a2 2 0 0 0 0 4h2M18 9h2a2 2 0 0 1 0 4h-2M6 4h12v5a6 6 0 0 1-12 0zM12 15v4M8 19h8"/></svg><p>No personal records yet.<br>Finish a workout to start setting them.</p></div>`;
  let h=`<div class="card"><div class="card-h"><div class="t">Personal Records · Est. 1RM</div></div>`;
  prs.forEach(([n,r])=>{h+=`<div class="pr-item"><div class="pr-medal"><svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M6 9H4a2 2 0 0 0 0 4h2M18 9h2a2 2 0 0 1 0 4h-2M6 4h12v5a6 6 0 0 1-12 0z"/></svg></div>
    <div><div class="pn">${n}</div><div class="small">${r.weight}lb × ${r.reps} · ${new Date(r.date).toLocaleDateString('default',{month:'short',day:'numeric'})}</div></div>
    <div class="pv">${r.orm}<small>lb</small></div></div>`;});
  h+=`</div>`;return h;
}

/* ---------- graphs (custom SVG line) ---------- */
function graphsView(){
  // pick exercises with >=2 data points
  const byEx={};
  S.logs.forEach(l=>l.exercises.forEach(e=>{if(e.warmup||!e.sets)return;const done=e.sets.filter(s=>s.done&&s.weight&&s.reps);if(!done.length)return;
    const best=Math.max(...done.map(s=>epley1RM(+s.weight,+s.reps)));
    (byEx[e.name]=byEx[e.name]||[]).push({date:l.date,v:best});}));
  const exes=Object.keys(byEx).filter(k=>byEx[k].length>=2);
  if(!exes.length)return`<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 3v18h18M7 14l4-4 3 3 5-6"/></svg><p>Log the same exercise at least twice<br>to see your progression curve.</p></div>`;
  // volume over time
  const volData=S.logs.map(l=>({date:l.date,v:Math.round(l.volume||0)}));
  let h='';
  if(volData.length>=2)h+=`<div class="card"><div class="card-h"><div class="t">Total Volume / Session</div></div>${lineChart(volData,'var(--acc)')}</div>`;
  exes.forEach(ex=>{h+=`<div class="card"><div class="card-h"><div class="t">${ex} · Est 1RM</div></div>${lineChart(byEx[ex],'var(--blue)')}</div>`;});
  return h;
}
function lineChart(data,color){
  const W=460,H=150,pad=28;
  const vals=data.map(d=>d.v);const min=Math.min(...vals)*0.95,max=Math.max(...vals)*1.05||1;
  const xs=i=>pad+(i/(data.length-1||1))*(W-pad*2);
  const ys=v=>H-pad-((v-min)/(max-min||1))*(H-pad*2);
  let pts=data.map((d,i)=>`${xs(i)},${ys(d.v)}`).join(' ');
  let area=`${pad},${H-pad} ${pts} ${xs(data.length-1)},${H-pad}`;
  let dots=data.map((d,i)=>`<circle cx="${xs(i)}" cy="${ys(d.v)}" r="3.5" fill="${color}"/>`).join('');
  return `<svg class="svg-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <polyline points="${area}" fill="${color}" opacity="0.08"/>
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round"/>
    ${dots}
    <text x="${pad}" y="14" fill="var(--txt3)" font-size="11" font-weight="700">${Math.round(max)}</text>
    <text x="${pad}" y="${H-8}" fill="var(--txt3)" font-size="11" font-weight="700">${Math.round(min)}</text>
  </svg>`;
}

/* ============================================================
   NUTRITION
   ============================================================ */
function renderNutrition(){
  const m=macroTarget();const plan=S.nutrition.plan||buildLocalMeals();
  const today=todayStr();
  const logged=S.nutrition.foodLog.filter(f=>f.date===today);
  const eaten=logged.reduce((t,f)=>({cals:t.cals+ +f.cals,p:t.p+ +(f.protein||0),c:t.c+ +(f.carbs||0),f:t.f+ +(f.fat||0)}),{cals:0,p:0,c:0,f:0});
  const goalLabel={bulk:'Bulking',cut:'Cutting',maintain:'Maintaining'}[S.profile.goal];
  let h=`<div class="page"><div class="topbar"><div><div class="sub">${goalLabel} · ${m.cals} kcal/day</div><h1>Fuel</h1></div></div>

  <div class="card">
    <div class="card-h"><div class="t">Today</div><button class="small" style="color:var(--acc);font-weight:700" onclick="logFood()">+ Log food</button></div>
    <div style="text-align:center;margin:6px 0 14px">
      <div class="disp" style="font-size:42px;line-height:1">${eaten.cals}<span style="font-size:18px;color:var(--txt2)"> / ${m.cals}</span></div>
      <div class="small">calories${eaten.cals>m.cals?' · over target':eaten.cals<m.cals?` · ${m.cals-eaten.cals} left`:''}</div>
    </div>
    <div style="height:8px;background:var(--bg3);border-radius:5px;overflow:hidden;margin-bottom:16px"><i style="display:block;height:100%;width:${Math.min(100,eaten.cals/m.cals*100)}%;background:var(--acc)"></i></div>
    <div class="macro-ring">
      <div class="mr"><div class="mv" style="color:var(--acc)">${eaten.p}</div><div class="ml">Protein</div><div class="p">/ ${m.protein}g</div></div>
      <div class="mr"><div class="mv" style="color:var(--blue)">${eaten.c}</div><div class="ml">Carbs</div><div class="p">/ ${m.carbs}g</div></div>
      <div class="mr"><div class="mv" style="color:var(--amber)">${eaten.f}</div><div class="ml">Fat</div><div class="p">/ ${m.fat}g</div></div>
    </div>
  </div>`;

  if(logged.length){h+=`<div class="card"><div class="card-h"><div class="t">Logged today</div></div>`;
    logged.forEach((f,i)=>h+=`<div class="food-log-item"><div><div class="fn">${f.name}</div><div class="fm">${f.protein||0}p · ${f.carbs||0}c · ${f.fat||0}f</div></div><div class="fc">${f.cals}</div><button onclick="delFood(${i})" style="color:var(--txt3);font-size:18px;padding:0 4px">×</button></div>`);
    h+=`</div>`;}

  h+=`<div class="card-h" style="margin:18px 4px 10px"><div class="t">Meal Ideas · ${goalLabel}</div></div>`;
  const slots={breakfast:'Breakfast',lunch:'Lunch',dinner:'Dinner'};
  for(const s in slots){const meal=plan.meals[s];
    h+=`<div class="meal"><div class="mh"><div class="mname">${slots[s]}</div><div class="mcal">${meal.cals} kcal</div></div>
      <div class="mdesc">${meal.n}</div>
      <div class="mmacros"><span>P <b>${meal.protein}g</b></span><span>C <b>${meal.carbs}g</b></span><span>F <b>${meal.fat}g</b></span></div>
      <button class="btn ghost sm" style="width:100%;margin-top:12px" onclick="quickLogMeal('${s}')">Log this meal</button></div>`;
  }
  if(S.settings.geminiKey)h+=`<button class="btn ghost" style="margin-top:6px" onclick="regenMeals()">↻ Fresh AI meal ideas</button>`;
  h+=`</div>`;
  $('#s_nutrition').innerHTML=h;
}
function logFood(){ openFoodForm({}); }
function openFoodForm(pre){
  pre=pre||{}; scanBusy=false;
  const esc=s=>(s||'').replace(/"/g,'&quot;');
  let banner='';
  if(pre.notFound) banner='<p class="small" style="color:var(--amber);margin-bottom:12px">Not found in the database — enter it manually.</p>';
  else if(pre.offline) banner='<p class="small" style="color:var(--red);margin-bottom:12px">Couldn\'t reach the food database. Check your connection or enter manually.</p>';
  else if(pre.per) banner=`<p class="small" style="color:var(--acc);margin-bottom:12px">✓ Found! Values ${pre.per}. Adjust to your portion.</p>`;
  modal(`<h3>Log food</h3>
    <button class="btn ghost" style="margin-bottom:16px" onclick="startScanner()">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M6 12h12"/></svg>
      Scan barcode</button>
    ${banner}
    <div class="field"><label>Food</label><input class="inp" id="lf_name" value="${esc(pre.name)}" placeholder="e.g. Chicken & rice"></div>
    <div class="row"><div class="field"><label>Calories</label><input class="inp" id="lf_cals" type="number" inputmode="numeric" value="${pre.cals||''}" placeholder="0"></div>
    <div class="field"><label>Protein (g)</label><input class="inp" id="lf_p" type="number" inputmode="numeric" value="${pre.protein||''}" placeholder="0"></div></div>
    <div class="row"><div class="field"><label>Carbs (g)</label><input class="inp" id="lf_c" type="number" inputmode="numeric" value="${pre.carbs||''}" placeholder="0"></div>
    <div class="field"><label>Fat (g)</label><input class="inp" id="lf_f" type="number" inputmode="numeric" value="${pre.fat||''}" placeholder="0"></div></div>
    <button class="btn" onclick="saveFood()">Add</button>
    <p class="small" style="text-align:center;margin-top:12px">Barcode lookup powered by the free Open Food Facts database.</p>`);
}
function saveFood(){
  const name=$('#lf_name').value.trim();const cals=+$('#lf_cals').value;
  if(!name||!cals){toast('Add a name and calories','bad');return;}
  S.nutrition.foodLog.push({date:todayStr(),name,cals,protein:+$('#lf_p').value||0,carbs:+$('#lf_c').value||0,fat:+$('#lf_f').value||0});
  save();closeModal();renderNutrition();toast('Logged','good');
}
function quickLogMeal(slot){const m=S.nutrition.plan.meals[slot];S.nutrition.foodLog.push({date:todayStr(),name:m.n,cals:m.cals,protein:m.protein,carbs:m.carbs,fat:m.fat});save();renderNutrition();toast('Meal logged','good');}
function delFood(i){const today=todayStr();const logged=S.nutrition.foodLog.filter(f=>f.date===today);const target=logged[i];S.nutrition.foodLog.splice(S.nutrition.foodLog.indexOf(target),1);save();renderNutrition();}
async function regenMeals(){toast('Generating…');try{
  const m=macroTarget();
  const txt=await geminiCall(`Give 3 ${S.profile.goal} meal ideas (breakfast, lunch, dinner) hitting ~${m.cals} kcal and ${m.protein}g protein total. Reply ONLY as JSON: {"breakfast":{"n":"name","cals":0,"protein":0,"carbs":0,"fat":0},"lunch":{...},"dinner":{...}}. No markdown.`);
  const clean=txt.replace(/```json|```/g,'').trim();const o=JSON.parse(clean);
  for(const s in o){o[s].n=o[s].n;o[s].cals=o[s].cals;}
  S.nutrition.plan={target:m,meals:o};save();renderNutrition();toast('Fresh ideas ready','good');
}catch(e){toast('Could not reach AI','bad');}}

/* ============================================================
   BODY — weight trend, measurements, photos
   ============================================================ */
function renderBody(){
  const wlog=S.body.weight.slice().sort((a,b)=>a.date<b.date?-1:1);
  const cur=wlog.length?wlog[wlog.length-1].v:S.profile.weight;
  const start=wlog.length?wlog[0].v:cur;
  const diff=round(cur-start,1);
  let h=`<div class="page"><div class="topbar"><div><div class="sub">Track your body</div><h1>Body</h1></div></div>

  <div class="card"><div class="card-h"><div class="t">Body Weight</div><button class="small" style="color:var(--acc);font-weight:700" onclick="logWeight()">+ Log</button></div>
    <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:4px">
      <div class="disp" style="font-size:40px">${cur||'—'}<span style="font-size:16px;color:var(--txt2)">lb</span></div>
      ${diff!==0?`<span style="font-weight:800;color:${diff>0?'var(--green)':'var(--blue)'}">${diff>0?'+':''}${diff}lb</span>`:''}
    </div>`;
  if(wlog.length>=2)h+=lineChart(wlog,'var(--acc)');
  else h+=`<p class="small">Log your weight a few times to see the trend.</p>`;
  h+=`</div>`;

  // measurements
  const meas=S.body.measurements.slice(-1)[0]||{};
  h+=`<div class="card"><div class="card-h"><div class="t">Measurements (in)</div><button class="small" style="color:var(--acc);font-weight:700" onclick="logMeas()">+ Update</button></div>
    <div class="meas-grid">
      ${['chest','waist','arms','thighs'].map(k=>`<div class="meas"><div class="mv">${meas[k]||'—'}</div><div class="ml">${k}</div></div>`).join('')}
    </div></div>`;

  // photos
  h+=`<div class="card"><div class="card-h"><div class="t">Progress Photos</div></div>
    <div class="photo-grid" id="photoGrid">
      <label class="photo-add"><input type="file" accept="image/*" capture="environment" style="display:none" onchange="addPhoto(this)">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg></label>
    </div>
    <p class="small" style="margin-top:10px">Photos are stored only on this device.</p>
  </div></div>`;
  $('#s_body').innerHTML=h;
  loadPhotos();
}
function logWeight(){modal(`<h3>Log body weight</h3><div class="field"><label>Weight (lb)</label><input class="inp" id="bw" type="number" inputmode="decimal" value="${S.profile.weight||''}"></div><button class="btn" onclick="saveWeight()">Save</button>`);}
function saveWeight(){const v=+$('#bw').value;if(!v){toast('Enter a weight','bad');return;}
  const today=todayStr();const ex=S.body.weight.find(w=>w.date===today);if(ex)ex.v=v;else S.body.weight.push({date:today,v});
  S.profile.weight=v;save();closeModal();renderBody();toast('Logged','good');}
function logMeas(){const m=S.body.measurements.slice(-1)[0]||{};
  modal(`<h3>Measurements (in)</h3>
  ${['chest','waist','arms','thighs'].map(k=>`<div class="field"><label>${k}</label><input class="inp" id="m_${k}" type="number" inputmode="decimal" value="${m[k]||''}"></div>`).join('')}
  <button class="btn" onclick="saveMeas()">Save</button>`);}
function saveMeas(){const o={date:todayStr()};['chest','waist','arms','thighs'].forEach(k=>{const v=+$('#m_'+k).value;if(v)o[k]=v;});
  S.body.measurements.push(o);save();closeModal();renderBody();toast('Saved','good');}

/* photos via IndexedDB (handles big base64) */
let photoDB;
function openPhotoDB(){return new Promise(res=>{const r=indexedDB.open('forge-photos',1);
  r.onupgradeneeded=e=>e.target.result.createObjectStore('p',{keyPath:'id'});
  r.onsuccess=e=>{photoDB=e.target.result;res();};r.onerror=()=>res();});}
async function addPhoto(input){
  const f=input.files[0];if(!f)return;await openPhotoDB();
  const reader=new FileReader();reader.onload=()=>{
    const id=Date.now();const tx=photoDB.transaction('p','readwrite');
    tx.objectStore('p').put({id,date:todayStr(),data:reader.result});
    tx.oncomplete=()=>{loadPhotos();toast('Photo saved','good');};
  };reader.readAsDataURL(f);
}
async function loadPhotos(){await openPhotoDB();if(!photoDB)return;
  const tx=photoDB.transaction('p','readonly');const req=tx.objectStore('p').getAll();
  req.onsuccess=()=>{const photos=req.result.sort((a,b)=>b.id-a.id);const g=$('#photoGrid');if(!g)return;
    const add=g.querySelector('.photo-add');g.innerHTML='';g.appendChild(add);
    photos.forEach(p=>{const d=el('div','ph',`<img src="${p.data}"><div class="pd">${new Date(p.date).toLocaleDateString('default',{month:'short',day:'numeric'})}</div>`);
      d.onclick=()=>modal(`<h3>${new Date(p.date).toLocaleDateString('default',{month:'long',day:'numeric',year:'numeric'})}</h3><img src="${p.data}" style="border-radius:14px;width:100%;margin-bottom:14px"><button class="btn ghost" style="background:var(--redbg);color:var(--red)" onclick="delPhoto(${p.id})">Delete photo</button><button class="btn ghost" style="margin-top:10px" onclick="closeModal()">Close</button>`);
      g.appendChild(d);});};
}
async function delPhoto(id){await openPhotoDB();const tx=photoDB.transaction('p','readwrite');tx.objectStore('p').delete(id);tx.oncomplete=()=>{closeModal();loadPhotos();};}

/* ============================================================
   SETTINGS
   ============================================================ */
function openSettings(){
  modal(`<h3>Settings</h3>
    <div class="field"><label>Gemini API Key (powers AI coaching)</label>
      <input class="inp" id="set_key" value="${S.settings.geminiKey||''}" placeholder="Paste your free key">
      <p class="small" style="margin-top:8px">Get a free key at <b style="color:var(--acc)">aistudio.google.com</b> → "Get API key". Stored only on this device.</p></div>
    <div class="field"><label>Notifications</label>
      <button class="btn ghost" onclick="enableNotifs()">${Notification.permission==='granted'?'✓ Enabled':'Enable reminders'}</button></div>
    <div class="divider"></div>
    <div class="field"><label>Goal</label><div class="chips">
      ${['bulk','cut','maintain'].map(g=>`<button class="chip ${S.profile.goal===g?'on':''}" onclick="changeGoal('${g}')">${g[0].toUpperCase()+g.slice(1)}</button>`).join('')}</div></div>
    <button class="btn" onclick="saveSettings()">Save</button>
    <button class="btn ghost" style="margin-top:10px" onclick="exportData()">Export my data</button>
    <button class="btn ghost" style="margin-top:10px;color:var(--red)" onclick="resetApp()">Reset everything</button>
    <p class="small" style="text-align:center;margin-top:16px">FORGE · all data stored locally on your device</p>`);
}
function changeGoal(g){S.profile.goal=g;S.nutrition.plan=buildLocalMeals();save();openSettings();}
function saveSettings(){S.settings.geminiKey=$('#set_key').value.trim();save();closeModal();toast('Saved','good');if(current==='home')renderHome();}
function enableNotifs(){if('Notification'in window)Notification.requestPermission().then(p=>{toast(p==='granted'?'Notifications on':'Permission denied',p==='granted'?'good':'bad');});}
function notify(title,body){if('Notification'in window&&Notification.permission==='granted'){
  if(navigator.serviceWorker?.ready){navigator.serviceWorker.ready.then(r=>r.showNotification(title,{body,icon:'icon-180.png',badge:'icon-180.png'})).catch(()=>new Notification(title,{body}));}
  else try{new Notification(title,{body});}catch(e){}}}
function exportData(){const blob=new Blob([JSON.stringify(S,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='forge-backup.json';a.click();}
function resetApp(){modal(`<h3>Reset everything?</h3><p style="color:var(--txt2);margin-bottom:18px">This wipes all your data permanently.</p><button class="btn" style="background:var(--red);color:#fff" onclick="localStorage.removeItem('forge');location.reload()">Yes, reset</button><button class="btn ghost" style="margin-top:10px" onclick="closeModal()">Cancel</button>`);}

/* ============================================================
   INIT + daily reminder
   ============================================================ */
function dailyReminderCheck(){
  if(Notification.permission!=='granted')return;
  const tw=todaysWorkout();if(tw&&!tw.rest&&!S.logs.some(l=>l.date===todayStr())){
    const last=localStorage.getItem('forge_reminded');
    if(last!==todayStr()&&new Date().getHours()>=16){notify('Workout pending 💪',`${tw.name} is on the schedule today.`);localStorage.setItem('forge_reminded',todayStr());}
  }
}
window.addEventListener('online',()=>{if(S.onboarded)toast('Back online — syncing AI');});
document.addEventListener('DOMContentLoaded',()=>{
  initOnb();
  if(S.onboarded){showApp();setTimeout(dailyReminderCheck,3000);}
});

/* ============================================================
   BARCODE SCANNER  — camera + free Open Food Facts database
   Native BarcodeDetector where available (Android/Chrome),
   ZXing fallback for iOS Safari. Lookup needs internet.
   ============================================================ */
let scanStream=null, scanLoop=null, zxingReader=null, scanBusy=false;

function loadZXing(){
  return new Promise((res,rej)=>{
    if(window.ZXing) return res();
    const s=document.createElement('script');
    s.src='https://cdn.jsdelivr.net/npm/@zxing/library@0.20.0/umd/index.min.js';
    s.onload=()=>res(); s.onerror=()=>rej(new Error('zxing load failed'));
    document.head.appendChild(s);
  });
}

async function startScanner(){
  scanBusy=false;
  modal(`<h3>Scan barcode</h3>
    <div style="position:relative;border-radius:16px;overflow:hidden;background:#000;aspect-ratio:3/4;margin-bottom:14px">
      <video id="scanVid" playsinline autoplay muted style="width:100%;height:100%;object-fit:cover"></video>
      <div style="position:absolute;inset:14px;border:2px solid var(--acc);border-radius:12px;pointer-events:none"></div>
      <div id="scanLine" style="position:absolute;top:50%;left:14%;right:14%;height:2px;background:var(--acc);box-shadow:0 0 14px var(--acc)"></div>
    </div>
    <p class="small" id="scanStatus" style="text-align:center">Point at a product barcode…</p>
    <button class="btn ghost" style="margin-top:12px" onclick="closeModal()">Cancel</button>`);
  // animate the scan line
  const line=$('#scanLine');
  if(line) line.animate([{top:'18%'},{top:'82%'},{top:'18%'}],{duration:2200,iterations:Infinity});

  const vid=$('#scanVid');
  try{
    if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)
      throw new Error('no camera api');

    if('BarcodeDetector' in window){
      // native path
      let formats=['ean_13','ean_8','upc_a','upc_e','code_128'];
      try{const sup=await BarcodeDetector.getSupportedFormats();formats=formats.filter(f=>sup.includes(f));}catch(e){}
      const det=new BarcodeDetector(formats.length?{formats}:undefined);
      scanStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}}});
      vid.srcObject=scanStream; await vid.play();
      scanLoop=setInterval(async()=>{
        if(scanBusy)return;
        try{const codes=await det.detect(vid); if(codes&&codes.length) onBarcode(codes[0].rawValue);}catch(e){}
      },350);
    } else {
      // ZXing fallback (iOS Safari)
      setStatus('Loading scanner…');
      await loadZXing();
      zxingReader=new ZXing.BrowserMultiFormatReader();
      await zxingReader.decodeFromConstraints({video:{facingMode:{ideal:'environment'}}}, vid, (result)=>{
        if(result && !scanBusy) onBarcode(result.getText());
      });
      setStatus('Point at a product barcode…');
    }
  }catch(e){
    setStatus('Camera unavailable — enter the food manually instead.','var(--red)');
    setTimeout(()=>{ if($('#modal').classList.contains('show')) openFoodForm({}); }, 1400);
  }
}
function setStatus(t,color){const s=$('#scanStatus'); if(s){s.textContent=t; s.style.color=color||'var(--txt3)';}}

function stopScanner(){
  if(scanLoop){clearInterval(scanLoop);scanLoop=null;}
  if(zxingReader){try{zxingReader.reset();}catch(e){} zxingReader=null;}
  if(scanStream){try{scanStream.getTracks().forEach(t=>t.stop());}catch(e){} scanStream=null;}
}

function onBarcode(code){
  if(scanBusy || !code) return;
  scanBusy=true; vibrate(45);
  setStatus('Found '+code+' — looking up…','var(--acc)');
  stopScanner();
  lookupBarcode(code);
}

async function lookupBarcode(code){
  try{
    const r=await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json?fields=product_name,brands,nutriments,serving_size`);
    const d=await r.json();
    if(d && d.status===1 && d.product){
      const p=d.product, n=p.nutriments||{};
      const hasServing = n['energy-kcal_serving']!=null || n.proteins_serving!=null;
      const pick=(s,h)=> hasServing && n[s]!=null ? n[s] : (n[h]!=null ? n[h] : 0);
      const cals=Math.round(pick('energy-kcal_serving','energy-kcal_100g'));
      const protein=Math.round(pick('proteins_serving','proteins_100g'));
      const carbs=Math.round(pick('carbohydrates_serving','carbohydrates_100g'));
      const fat=Math.round(pick('fat_serving','fat_100g'));
      const name=[p.brands,p.product_name].filter(Boolean).join(' — ').trim() || ('Product '+code);
      openFoodForm({name,cals,protein,carbs,fat,per: hasServing ? ('per '+(p.serving_size||'serving')) : 'per 100g'});
    } else {
      openFoodForm({notFound:true});
    }
  }catch(e){
    openFoodForm({offline:true});
  }
}
