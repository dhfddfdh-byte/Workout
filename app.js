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
function epley1RM(w,reps){const r=Math.min(+reps||1,12);return r<=1?w:Math.round(w*(1+r/30));}
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
// 9 levels: sh=shoulder half-width, wa=waist half-width, abs=detail strength 0..1
const BF_LEVELS=[
  {pct:'3-4%',  sh:40, wa:22, abs:1.0, vasc:1, cue:'Striated, vascular, paper-thin skin'},
  {pct:'5-7%',  sh:40, wa:23, abs:0.92,vasc:.6,cue:'Full 6-pack, sharp separation'},
  {pct:'8-12%', sh:39, wa:25, abs:0.78,vasc:.2,cue:'Abs clearly visible, lean'},
  {pct:'13-17%',sh:38, wa:28, abs:0.52,vasc:0, cue:'Top abs show, athletic'},
  {pct:'18-23%',sh:38, wa:31, abs:0.28,vasc:0, cue:'Flat, faint outline only'},
  {pct:'24-29%',sh:38, wa:35, abs:0.10,vasc:0, cue:'No definition, soft midsection'},
  {pct:'30-34%',sh:39, wa:40, abs:0,   vasc:0, cue:'Rounder belly, fuller waist'},
  {pct:'35-39%',sh:40, wa:45, abs:0,   vasc:0, cue:'Belly protrudes, soft chest'},
  {pct:'40%+',  sh:42, wa:51, abs:0,   vasc:0, cue:'Large midsection, little shape'}
];
function bodySVG(L,female){
  // Front-facing torso illustration modeled on a real body-fat reference chart.
  // Low BF = broad shoulders, deep V-taper, hard ab grid, serratus + vascularity.
  // High BF = the waist/belly rounds out into a barrel, all detail fades, pecs soften.
  // viewBox 0 0 130 168.  Arms hang at the sides leaving dark cutout gaps.
  const id='bf'+Math.round(L.wa*10)+(L.abs*100|0);
  const skin='#c2c6cd', skinHi='#d2d6dc', edge='#7e828b', det='#5f636c', shadow='#9a9ea6';
  const cx=65, def=L.abs;                       // def 0..1 = how visible the muscle detail is
  const shoulder=L.sh+4, waist=L.wa;            // widths
  const neckY=18, shY=36, ribY=86, navelY=120, hipY=150;
  // belly bulge grows with fat; widest point sinks toward the navel
  const gut = waist>34 ? (waist-32)*0.7 : 0;
  const wRib = waist + gut*0.35;                // ribcage width
  const wNav = waist + gut;                     // belly width (widest when fat)
  // ---- torso silhouette ----
  const torso=`M${cx-11} ${neckY}
    C${cx-16} ${neckY+5} ${cx-shoulder+7} ${shY-6} ${cx-shoulder} ${shY+8}
    C${cx-shoulder+2} ${shY+24} ${cx-wRib-2} ${ribY-14} ${cx-wRib} ${ribY}
    C${cx-wRib-1} ${ribY+16} ${cx-wNav-1} ${navelY-12} ${cx-wNav} ${navelY}
    C${cx-wNav+1} ${navelY+16} ${cx-waist+4} ${hipY-6} ${cx-waist+12} ${hipY}
    L${cx+waist-12} ${hipY}
    C${cx+waist-4} ${hipY-6} ${cx+wNav-1} ${navelY+16} ${cx+wNav} ${navelY}
    C${cx+wNav+1} ${navelY-12} ${cx+wRib+1} ${ribY+16} ${cx+wRib} ${ribY}
    C${cx+wRib+2} ${ribY-14} ${cx+shoulder-2} ${shY+24} ${cx+shoulder} ${shY+8}
    C${cx+shoulder-7} ${shY-6} ${cx+16} ${neckY+5} ${cx+11} ${neckY} Z`;
  // ---- upper arms hanging at the sides (separate = dark gap shows through) ----
  const armW=14;
  const armL=`M${cx-shoulder-1} ${shY+6}
    C${cx-shoulder-armW} ${shY+20} ${cx-shoulder-armW+2} ${ribY-6} ${cx-wRib-9} ${navelY-6}
    l9 3 C${cx-shoulder+4} ${ribY-8} ${cx-shoulder+5} ${shY+22} ${cx-shoulder+4} ${shY+9} Z`;
  const armR=`M${cx+shoulder+1} ${shY+6}
    C${cx+shoulder+armW} ${shY+20} ${cx+shoulder+armW-2} ${ribY-6} ${cx+wRib+9} ${navelY-6}
    l-9 3 C${cx+shoulder-4} ${ribY-8} ${cx+shoulder-5} ${shY+22} ${cx+shoulder-4} ${shY+9} Z`;
  const neck=`<path d="M${cx-9} ${neckY-12} q9 5 18 0 l1 12 q-10 5 -20 0 Z" fill="${skin}" stroke="${edge}" stroke-width="0.8"/>`;
  // ---- muscle / fat detail (opacity scales with def) ----
  let detail='';
  const o=v=>Math.max(0,Math.min(1,v)).toFixed(2);
  // deltoid caps
  detail+=`<path d="M${cx-shoulder+2} ${shY+4} a11 11 0 0 1 11 6" stroke="${det}" stroke-width="1.2" fill="none" opacity="${o(0.35+def*0.4)}"/>`;
  detail+=`<path d="M${cx+shoulder-2} ${shY+4} a11 11 0 0 0 -11 6" stroke="${det}" stroke-width="1.2" fill="none" opacity="${o(0.35+def*0.4)}"/>`;
  // pecs: two masses, cleavage line down the middle, shadow under each
  const pecB=shY+34;
  detail+=`<path d="M${cx} ${shY+13} V${pecB-2}" stroke="${det}" stroke-width="1.5" opacity="${o(0.3+def*0.6)}"/>`;
  detail+=`<path d="M${cx-wRib+9} ${pecB-2} Q${cx-13} ${pecB+8} ${cx-2} ${pecB-2}" stroke="${det}" stroke-width="1.8" fill="none" opacity="${o(0.35+def*0.5)}"/>`;
  detail+=`<path d="M${cx+wRib-9} ${pecB-2} Q${cx+13} ${pecB+8} ${cx+2} ${pecB-2}" stroke="${det}" stroke-width="1.8" fill="none" opacity="${o(0.35+def*0.5)}"/>`;
  // saggy/soft pec underline at high BF
  if(gut>6){detail+=`<path d="M${cx-wRib+8} ${pecB+2} Q${cx-13} ${pecB+14} ${cx-3} ${pecB+6}" stroke="${shadow}" stroke-width="2.4" fill="none" opacity="0.4"/>
    <path d="M${cx+wRib-8} ${pecB+2} Q${cx+13} ${pecB+14} ${cx+3} ${pecB+6}" stroke="${shadow}" stroke-width="2.4" fill="none" opacity="0.4"/>`;}
  // ab grid: linea alba + rows of cross-cuts (fade with def)
  const abTop=pecB+6, abBot=navelY-gut*0.5-6;
  detail+=`<path d="M${cx} ${abTop} V${abBot}" stroke="${det}" stroke-width="1.4" opacity="${o(def)}"/>`;
  for(let r=1;r<=3;r++){
    const y=abTop+(abBot-abTop)*(r/3.3);
    const half=10-r*0.7;
    detail+=`<path d="M${cx-half} ${y} h${half-1.5}" stroke="${det}" stroke-width="1.3" opacity="${o(def*0.95)}"/>`;
    detail+=`<path d="M${cx+1.5} ${y} h${half-1.5}" stroke="${det}" stroke-width="1.3" opacity="${o(def*0.95)}"/>`;
  }
  // oblique V-cut toward the waist (lean only)
  detail+=`<path d="M${cx-wRib+5} ${abBot-16} Q${cx-11} ${abBot+2} ${cx-3} ${abBot+9}" stroke="${det}" stroke-width="1.3" fill="none" opacity="${o(def*0.85)}"/>`;
  detail+=`<path d="M${cx+wRib-5} ${abBot-16} Q${cx+11} ${abBot+2} ${cx+3} ${abBot+9}" stroke="${det}" stroke-width="1.3" fill="none" opacity="${o(def*0.85)}"/>`;
  // serratus finger-ticks (very lean only)
  if(def>0.7){for(let i=0;i<3;i++){const y=pecB+6+i*7;
    detail+=`<path d="M${cx-wRib+8+i*2} ${y} l5 3" stroke="${det}" stroke-width="1" opacity="${o((def-0.7)*2.5)}"/>`;
    detail+=`<path d="M${cx+wRib-8-i*2} ${y} l-5 3" stroke="${det}" stroke-width="1" opacity="${o((def-0.7)*2.5)}"/>`;}}
  // vascularity (extreme lean)
  if(L.vasc>0){detail+=`<path d="M${cx-shoulder+10} ${shY+18} q5 14 1 30" stroke="${det}" stroke-width="0.8" fill="none" opacity="${o(L.vasc*0.55)}"/>
    <path d="M${cx+shoulder-10} ${shY+18} q-5 14 -1 30" stroke="${det}" stroke-width="0.8" fill="none" opacity="${o(L.vasc*0.55)}"/>`;}
  // navel
  detail+=`<ellipse cx="${cx}" cy="${navelY-gut*0.4}" rx="1.6" ry="2.4" fill="${det}" opacity="0.55"/>`;
  // soft belly rounding shadow at high BF
  let belly='';
  if(gut>4){belly=`<ellipse cx="${cx}" cy="${navelY-6}" rx="${wNav-7}" ry="26" fill="${shadow}" opacity="0.16"/>`;}
  // white briefs at the very bottom
  const bw=waist-6;
  const briefs=`<path d="M${cx-bw} ${hipY-8} L${cx+bw} ${hipY-8} L${cx+bw-2} ${hipY-2} Q${cx} ${hipY+4} ${cx} ${hipY+14} Q${cx} ${hipY+4} ${cx-bw+2} ${hipY-2} Z" fill="#eef0f3"/>`;
  return `<svg viewBox="0 0 130 168" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${skinHi}"/><stop offset="1" stop-color="${skin}"/></linearGradient></defs>
    ${neck}
    <path d="${armL}" fill="url(#${id})" stroke="${edge}" stroke-width="0.8"/>
    <path d="${armR}" fill="url(#${id})" stroke="${edge}" stroke-width="0.8"/>
    <path d="${torso}" fill="url(#${id})" stroke="${edge}" stroke-width="1"/>
    ${belly}${detail}${briefs}
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
    {id:'curlbar',n:'Curl bar'},{id:'fixedbar',n:'Fixed-weight bars'},
    {id:'trapbar',n:'Trap / hex bar'},{id:'weightvest',n:'Weight vest'},
    {id:'ankleweights',n:'Ankle weights'},{id:'plateloaded',n:'Plate-loaded handles'}
  ]},
  {cat:'Racks & benches', items:[
    {id:'rack',n:'Squat rack'},{id:'cage',n:'Power cage'},
    {id:'bench',n:'Adjustable bench'},{id:'flatbench',n:'Flat bench'},
    {id:'smith',n:'Smith machine'},{id:'preacher',n:'Preacher pad'}
  ]},
  {cat:'Machines & cables', items:[
    {id:'cables',n:'Cable machine'},{id:'functional',n:'Functional trainer'},
    {id:'machines',n:'Selectorized machines'},{id:'legpress',n:'Leg press'},
    {id:'legcurl',n:'Leg curl / extension'},{id:'latpull',n:'Lat pulldown'},
    {id:'pec',n:'Pec deck'},{id:'rowmachine',n:'Row machine'}
  ]},
  {cat:'Bars & bodyweight', items:[
    {id:'pullup',n:'Pull-up bar'},{id:'doorbar',n:'Doorframe pull-up bar'},
    {id:'dip',n:'Dip station'},{id:'rings',n:'Gymnastic rings'},
    {id:'trx',n:'TRX / suspension'},{id:'parallettes',n:'Parallettes'},
    {id:'pushuphandles',n:'Push-up handles'},{id:'pushupboard',n:'Push-up board'},
    {id:'dipbelt',n:'Dip belt'}
  ]},
  {cat:'Bands & accessories', items:[
    {id:'bands',n:'Resistance bands'},{id:'miniband',n:'Mini loop bands'},
    {id:'tubehandles',n:'Tube bands w/ handles'},{id:'abwheel',n:'Ab wheel'},
    {id:'medball',n:'Medicine ball'},{id:'slamball',n:'Slam ball'},
    {id:'sandbag',n:'Sandbag'},{id:'bosu',n:'BOSU ball'},
    {id:'stabball',n:'Stability ball'},{id:'battleropes',n:'Battle ropes'},
    {id:'plyobox',n:'Plyo box'},{id:'foamroller',n:'Foam roller'},
    {id:'landmine',n:'Landmine'},{id:'liftbelt',n:'Lifting belt'}
  ]},
  {cat:'Cardio', items:[
    {id:'jumprope',n:'Jump rope'},{id:'treadmill',n:'Treadmill'},
    {id:'bike',n:'Stationary bike'},{id:'assault',n:'Assault bike'},
    {id:'rower',n:'Rowing machine'},{id:'elliptical',n:'Elliptical'},
    {id:'stairstepper',n:'Stair stepper'}
  ]},
  {cat:'Home / improvised', items:[
    {id:'backpack',n:'Loaded backpack'},{id:'books',n:'Books / heavy objects'},
    {id:'jugs',n:'Water jugs / gallons'},{id:'chair',n:'Sturdy chair'},
    {id:'counter',n:'Counter (for dips)'},{id:'table',n:'Table (for rows)'},
    {id:'towel',n:'Towel'},{id:'stairs',n:'Stairs / step'},
    {id:'wall',n:'Wall'},{id:'crate',n:'Box / crate'},
    {id:'suitcase',n:'Filled suitcase'},{id:'dooranchor',n:'Door anchor (bands)'}
  ]}
];
// Quick presets that bulk-select equipment.
const EQUIP_PRESETS=[
  {id:'publicgym',n:'🏋️ Public / commercial gym',ids:['dumbbells','barbell','kettlebell','ezbar','trapbar','rack','cage','bench','flatbench','smith','preacher','cables','functional','machines','legpress','legcurl','latpull','pec','rowmachine','pullup','dip','jumprope','treadmill','bike','rower','elliptical','bands','medball','plyobox','foamroller','liftbelt']},
  {id:'homegym',n:'🏠 Home gym (typical)',ids:['dumbbells','barbell','kettlebell','bench','rack','pullup','bands','jumprope','abwheel','foamroller']},
  {id:'minimal',n:'🎒 Minimal / improvised',ids:['dumbbells','backpack','books','jugs','chair','counter','table','stairs','wall','bodyweight','pushuphandles']},
  {id:'bodyonly',n:'🤸 Bodyweight only',ids:['bodyweight','wall','chair','stairs']}
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
  renderPresets();
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

function renderPresets(){
  const wrap=$('#presetChips');if(!wrap)return;wrap.innerHTML='';
  EQUIP_PRESETS.forEach(p=>{
    const b=el('button','chip','<b>'+p.n+'</b>');
    b.onclick=()=>applyPreset(p);
    wrap.appendChild(b);
  });
}
function applyPreset(p){
  // turn on every chip in the preset (keeps anything already selected)
  const set=new Set(p.ids);
  $$('#equipCats .chip').forEach(c=>{if(set.has(c.dataset.eq))c.classList.add('on');});
  toast(p.n.replace(/^\S+\s/,'')+' selected — tweak anything you want','good');
  renderWeights();
}
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
      b.dataset.eq=it.id;b.onclick=()=>{b.classList.toggle('on');renderWeights();};
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
// Paste a product link; Gemini reads it and figures out what you've got.
function linkEquipment(){
  modal(`<h3>🔗 Link your equipment</h3>
    <p style="color:var(--txt2);margin-bottom:14px;line-height:1.5">Paste a link to a weight set or gear (Walmart, Amazon, etc). I'll read it and fill in your weights automatically.${S.settings.geminiKey?'':'<br><br><b style="color:var(--amber)">Needs a free Gemini key first (Settings → AI).</b> Without it, I can still match common keywords.'}</p>
    <div class="field"><input class="inp" id="le_url" placeholder="https://..."></div>
    <button class="btn" id="le_go" onclick="readEquipmentLink()">Read it</button>`);
}
async function readEquipmentLink(){
  const url=$('#le_url').value.trim();if(!url){toast('Paste a link first','bad');return;}
  const btn=$('#le_go');btn.textContent='Reading…';btn.disabled=true;
  let title='';
  // try to read the page title/description via a public reader (no key needed)
  try{
    const r=await fetch('https://r.jina.ai/'+url,{headers:{'Accept':'text/plain'}});
    if(r.ok){const t=await r.text();title=t.slice(0,1500);}
  }catch(e){/* reader blocked — fall back to URL keywords */}
  const text=(title||url).toLowerCase();
  const found=new Set();let bbMax=0,dbMax=0;
  // keyword matching for equipment types
  const kw={dumbbells:/dumbbell/,barbell:/barbell|bar set/,kettlebell:/kettlebell|kettle bell/,
    pushuphandles:/push.?up handle/,pushupboard:/push.?up board/,bands:/resistance band/,
    bench:/bench/,ezbar:/ez bar|ez curl/,curlbar:/curl bar/,pullup:/pull.?up bar/,
    weightvest:/weight vest|weighted vest/,ankleweights:/ankle weight/,medball:/medicine ball/,
    jumprope:/jump rope|skipping rope/,abwheel:/ab wheel|ab roller/};
  for(const id in kw){if(kw[id].test(text))found.add(id);}
  // pull a max poundage like "60LB" / "60 lb" / "60-pound"
  const m=text.match(/(\d{2,3})\s?(?:lb|lbs|pound)/);
  if(m){const total=+m[1];
    if(found.has('barbell')||/barbell|adjustable/.test(text))bbMax=total;
    if(found.has('dumbbells'))dbMax=Math.round(total/2); // a set's total usually splits across 2 DBs
  }
  if(!found.size){closeModal();toast("Couldn't read that link — add items manually","bad");return;}
  // apply: select the chips, store maxes
  found.forEach(id=>{const c=$(`#equipCats .chip[data-eq="${id}"]`);if(c)c.classList.add('on');});
  if(bbMax)S.profile.barbellMax=bbMax;
  if(dbMax){
    // build sensible dumbbell increments up to dbMax
    const dbs=[];for(let w=5;w<=dbMax;w+=5)dbs.push(w);S.profile.dumbbells=dbs;
  }
  save();renderWeights();closeModal();
  toast(`Found: ${[...found].map(id=>id).join(', ')}${bbMax?` · barbell to ${bbMax}lb`:''}`,'good');
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
  const sec=$('#weightSection');if(!sec)return;sec.innerHTML='';
  // Dumbbells
  const dbOwned=new Set(S.profile.dumbbells||[]);
  const dbGroup=el('div','wgroup',`<div class="wl">Dumbbells (lb)</div><div class="wh">Tap each weight you can make (per hand)</div>`);
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
  // Barbell max — this is the key fix: cap suggestions at what you can actually load
  if(eq.has('barbell')||eq.has('smith')||eq.has('ezbar')||eq.has('curlbar')){
    const cur=S.profile.barbellMax||'';
    const g=el('div','wgroup',`<div class="wl">Barbell — max you can load</div>
      <div class="wh">Total weight including the bar. (Your adjustable set tops out here.)</div>`);
    const row=el('div','addw');
    const inp=el('input');inp.type='number';inp.inputMode='decimal';inp.placeholder='e.g. 60';inp.value=cur;inp.id='bbMaxInp';
    inp.onchange=()=>{S.profile.barbellMax=+inp.value||0;};
    const lbl=el('span','small');lbl.style.cssText='align-self:center;white-space:nowrap';lbl.textContent='lb total';
    row.appendChild(inp);row.appendChild(lbl);
    g.appendChild(row);sec.appendChild(g);
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
    {n:'Barbell Bench Press',eq:['barbell'],req:['bench','flatbench','rack'],c:'Lower bar to mid-chest, drive up. Keep shoulder blades pinned.'},
    {n:'Dumbbell Bench Press',eq:['dumbbells'],req:['bench','flatbench'],c:'Press DBs over chest, control the stretch at bottom.'},
    {n:'Incline Dumbbell Press',eq:['dumbbells'],req:['bench'],c:'Bench at 30°. Targets upper chest.'},
    {n:'Dumbbell Fly',eq:['dumbbells'],req:['bench'],c:'Slight elbow bend, hug a tree motion.'},
    {n:'Dumbbell Floor Press',eq:['dumbbells'],c:'Lying on the floor — press DBs up. No bench needed; elbows stop at the floor.'},
    {n:'Cable Crossover',eq:['cables'],c:'Squeeze chest at the bottom of the arc.'},
    {n:'Machine Chest Press',eq:['machines','pec'],c:'Press handles together, control the return.'},
    {n:'Push-up',eq:['bodyweight','wall'],c:'Body in a straight line, full range.'},
    {n:'Wide Push-up',eq:['bodyweight','pushupboard','pushuphandles'],c:'Hands wider than shoulders — outer chest focus.'},
    {n:'Decline Push-up',eq:['bodyweight','pushupboard','chair','stairs'],c:'Feet elevated — hits upper chest.'},
    {n:'Deep Push-up (handles)',eq:['pushuphandles','pushupboard'],c:'Grip handles, lower past your hands for a deeper stretch.'},
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
    {n:'Close-Grip Bench',eq:['barbell'],req:['bench','flatbench','rack'],c:'Tuck elbows, press, tricep focus.'},
    {n:'Close-Grip Floor Press',eq:['barbell','dumbbells'],c:'Lying on the floor, elbows tucked — tricep press with no bench.'},
    {n:'Tricep Pushdown',eq:['cables'],c:'Elbows fixed, full extension.'},
    {n:'Overhead Tricep Ext',eq:['dumbbells','kettlebell'],c:'Lower weight behind head, extend.'},
    {n:'Dips',eq:['bodyweight','pullup','dip','chair','counter','parallettes'],c:'Lean slightly, full depth on bars/chairs/counter.'},
    {n:'Skull Crusher',eq:['dumbbells','barbell','ezbar'],req:['bench','flatbench'],c:'Lower to forehead, extend.'},
    {n:'Floor Skull Crusher',eq:['dumbbells','ezbar'],c:'On the floor — lower toward forehead, extend. No bench needed.'},
    {n:'Diamond Push-up',eq:['bodyweight'],c:'Hands together, elbows tucked.'},
    {n:'Narrow Push-up (board)',eq:['pushupboard','pushuphandles'],c:'Narrow hand position — tricep emphasis.'},
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
const MUSCLE_LABELS={warmup:'Warm-up',cardio:'Cardio',chest:'Chest',back:'Back',lats:'Lats',quads:'Quads',hamstrings:'Hamstrings',glutes:'Glutes',frontDelt:'Front Delts',sideDelt:'Side Delts',rearDelt:'Rear Delts',biceps:'Biceps',triceps:'Triceps',forearms:'Forearms',abs:'Abs',calves:'Calves',traps:'Traps'};

function pickExercise(muscle,exclude,variantSeed){
  // bodyweight is ALWAYS available — everyone has their own body
  const eq=(S.profile.equipment||[]).concat('bodyweight');
  const hated=(S.profile.hated||'').toLowerCase().split(/[,;]/).map(h=>h.trim()).filter(Boolean);
  const injured=(S.profile.injuries||'').toLowerCase();
  const list=(EXLIB[muscle]||[]).filter(x=>
    x.eq.some(e=>eq.includes(e)) &&
    (!x.req || x.req.some(r=>eq.includes(r))) &&   // needs at least one of req (e.g. a bench)
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
  const pool=safe.length?safe:list;
  if(pool.length){
    // rotate by a seed (e.g. the day index) so the same muscle gets a different
    // movement on different days instead of the identical lift every time
    const i=((variantSeed||0)%pool.length+pool.length)%pool.length;
    return pool[i];
  }
  // last-resort fallback: the first library move the user can ACTUALLY do
  // (respects equipment + req), so we never hand back a bench move with no bench
  const doable=(EXLIB[muscle]||[]).find(x=>
    x.eq.some(e=>eq.includes(e)) && (!x.req||x.req.some(r=>eq.includes(r))));
  return doable||null;
}

/* ---------- weights snapping to what you actually own ----------
   barbellMax / dumbbellMax come from the profile (set in onboarding or
   read from a product link). We NEVER suggest a weight above what's owned. */
function barbellPlatesUpTo(max){
  // realistic loadable barbell weights from an empty bar up to max, in 5lb steps
  const bar=max>=45?45:Math.max(5,Math.round(max*0.15)); // adjustable sets have light bars
  const out=[];for(let w=bar;w<=max;w+=5)out.push(w);
  if(out[out.length-1]!==max)out.push(max);
  return out.length?out:[max];
}
function availableWeights(ex){
  const dbs=(S.profile.dumbbells||[]).slice().sort((a,b)=>a-b);
  const kbs=(S.profile.kettlebells||[]).slice().sort((a,b)=>a-b);
  const eq=S.profile.equipment||[];
  const bbMax=+S.profile.barbellMax||0;
  if(/kettlebell|swing/i.test(ex.n) && kbs.length) return kbs;
  if(/dumbbell|db |goblet|hammer|lateral|fly|curl|raise|farmer|arnold|rdl/i.test(ex.n) && dbs.length) return dbs;
  if((eq.includes('barbell')||eq.includes('smith')||eq.includes('ezbar')||eq.includes('curlbar')) && /barbell|bench|squat|deadlift|press|row|curl|skull|close-grip/i.test(ex.n)){
    if(bbMax>0) return barbellPlatesUpTo(bbMax);            // capped at real set max
    return barbellPlatesUpTo(135);                          // conservative default if unknown
  }
  if(dbs.length) return dbs;
  if(kbs.length) return kbs;
  return null; // bodyweight / improvised — no fixed weight
}
// best assessed 1RM that maps to this exercise's muscles (so we anchor to real strength)
function assessed1RMForMuscle(muscle){
  let best=0;
  for(const k in S.lifts){const l=S.lifts[k];if(!l||l.unknown||!l.weight)continue;
    if((LIFT_MUSCLES[k]||[]).includes(muscle)){best=Math.max(best,epley1RM(+l.weight,+l.reps||1));}
  }
  return best; // 0 if none assessed
}
function suggestStartWeight(ex,muscle,repTarget){
  const avail=availableWeights(ex);
  if(!avail||!avail.length) return null; // bodyweight/improvised: user sets load when logging
  // working weight = % of 1RM appropriate for the rep target (Brzycki-ish table)
  const reps=repTarget||10;
  const pctOf1RM=Math.max(0.55,Math.min(0.85, 1.0278 - 0.0278*reps)); // ~75% at 10 reps
  const oneRM=assessed1RMForMuscle(muscle);
  let target;
  if(oneRM>0){
    target=oneRM*pctOf1RM;
    if(S.profile.experience==='new') target*=0.9; // beginners start a touch lighter
  }else{
    // No assessed lift for this muscle. Estimate a sensible untrained working
    // weight from bodyweight + the movement type, then snap to what's owned.
    const bw=+S.profile.weight||150;
    const n=(ex.n||'').toLowerCase();
    const isDB=/dumbbell|db |goblet|hammer|lateral|fly|curl|raise|arnold|rdl|kettlebell/i.test(n)
               || (avail===S.profile.dumbbells);
    let frac; // fraction of bodyweight a NOVICE handles for a working set
    if(/squat|leg press|hip thrust|deadlift|rdl|romanian/.test(n)) frac=0.45;
    else if(/bench|row|press|pulldown/.test(n)) frac=0.30;
    else if(/curl|extension|raise|fly|pushdown|lateral|reverse/.test(n)) frac=0.12;
    else frac=0.20;
    target=bw*frac;
    if(isDB) target/=2;            // per-hand for dumbbell moves
    if(S.profile.experience==='new') target*=0.85;
    if(S.profile.experience==='exp') target*=1.15;
  }
  // snap DOWN to the closest owned weight that doesn't exceed target (never over),
  // but never below the lightest available
  let pick=avail[0];
  for(const w of avail){ if(w<=target) pick=w; else break; }
  return pick;
}

/* ============================================================
   PROGRAM GENERATION
   Every split keeps the whole body covered — legs are never skipped.
   Priority muscles get EXTRA volume, but big compounds still lead the
   session, so a priority never turns the day into "arms only".
   ============================================================ */
function splitFor(days){
  if(days<=2) return [
    {name:'Full Body A',muscles:['quads','chest','back','sideDelt','biceps','abs','calves']},
    {name:'Full Body B',muscles:['hamstrings','glutes','chest','back','triceps','rearDelt','abs']}
  ];
  if(days===3) return [
    {name:'Full Body A',muscles:['quads','chest','back','sideDelt','biceps','abs']},
    {name:'Full Body B',muscles:['hamstrings','glutes','frontDelt','back','triceps','calves']},
    {name:'Full Body C',muscles:['quads','chest','back','rearDelt','biceps','abs']}
  ];
  if(days===4) return [
    {name:'Upper A',muscles:['chest','back','sideDelt','biceps','triceps','abs']},
    {name:'Lower A',muscles:['quads','hamstrings','glutes','calves','abs']},
    {name:'Upper B',muscles:['back','frontDelt','chest','triceps','biceps','rearDelt']},
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
// fixed rep targets (single number, not a range) chosen by goal + experience
function repScheme(){
  const g=S.profile.goal,exp=S.profile.experience;
  if(g==='cut') return {sets:3,reps:12,rest:60};
  if(g==='bulk') return {sets:exp==='new'?3:4,reps:10,rest:exp==='new'?90:105};
  if(exp==='new') return {sets:3,reps:10,rest:90};
  if(exp==='exp') return {sets:4,reps:8,rest:120};
  return {sets:4,reps:10,rest:105};
}
// rep target per muscle — small muscles & abs get higher reps
function repsForMuscle(muscle,base){
  if(['abs','calves','forearms','rearDelt','sideDelt'].includes(muscle)) return Math.min(15,base+5);
  if(['biceps','triceps'].includes(muscle)) return base+2;
  return base;
}
// how many WORK exercises fit a session of N minutes (after ~8 min warmup)
function exercisesForTime(min){
  const usable=Math.max(12,min-8);
  return Math.max(3,Math.min(8,Math.round(usable/9)));
}
function warmupFor(day){
  const lower=day.muscles.some(m=>['quads','hamstrings','glutes','calves'].includes(m));
  const items=lower
    ? ['3-5 min easy cardio (march, jog, or bike)','Leg swings × 10 each','Bodyweight squats × 15','Glute bridges × 15','2 light ramp-up sets of your first lift']
    : ['3-5 min easy cardio / arm circles','Band or towel pull-aparts × 15','Scapular push-ups × 10','Shoulder rotations × 10 each','2 light ramp-up sets of your first lift'];
  return {name:'Warm-up',muscle:'warmup',cue:'Raise your heart rate and prime the joints you\'re about to train.',warmup:true,items,sets:1,reps:'~8 min',rest:0,weight:null};
}
function cardioFinisher(){
  const eq=S.profile.equipment||[];
  let pick='Brisk walk or light jog';
  if(eq.includes('jumprope'))pick='Jump rope intervals';
  else if(eq.includes('treadmill'))pick='Treadmill intervals';
  else if(eq.includes('bike')||eq.includes('assault'))pick='Bike intervals';
  else if(eq.includes('rower'))pick='Rowing intervals';
  else if(eq.includes('stairs'))pick='Stair intervals';
  return {name:pick,muscle:'cardio',cue:'Optional finisher — 5-10 min steady or 30s hard / 30s easy intervals.',cardio:true,items:['5-10 minutes','Steady pace, or 30s hard / 30s easy','Goal: heart rate up, breathing hard'],sets:1,reps:'5-10 min',rest:0,weight:null};
}
function buildLocalProgram(){
  const days=S.profile.days||4;
  const split=splitFor(days);
  const scheme=repScheme();
  const maxEx=exercisesForTime(S.profile.workoutMin||60);
  const priority=new Set(S.profile.priority||[]);
  const wantsCardio=(S.profile.goal==='cut')||(S.profile.cardio===true);
  const program={days, scheme, week:1, workoutMin:S.profile.workoutMin||60,
    lengthMonths:S.profile.lengthMonths||'3', startDate:todayStr(),
    split:split.map((d,dayIdx)=>{
    const exercises=[];const used=new Set();
    // 1) FIRST pass: one solid exercise for EVERY muscle in the day, in the day's order
    //    (compounds/legs lead — we do NOT reorder priority to the front)
    d.muscles.forEach(m=>{
      const ex=pickExercise(m,used,dayIdx);if(!ex||used.has(ex.n))return;used.add(ex.n);
      const isPriority=priority.has(m);
      const reps=repsForMuscle(m,scheme.reps);
      exercises.push({name:ex.n,muscle:m,cue:ex.c,
        sets:scheme.sets+(isPriority?1:0), // priority = +1 set
        reps,
        weight:suggestStartWeight(ex,m,reps),rest:scheme.rest,priority:isPriority});
    });
    // 2) SECOND pass: add an extra exercise for priority muscles, time permitting
    if(exercises.length<maxEx){
      d.muscles.filter(m=>priority.has(m)).forEach(m=>{
        if(exercises.length>=maxEx)return;
        const ex=pickExercise(m,used,dayIdx+1);if(!ex||used.has(ex.n))return;used.add(ex.n);
        const reps=repsForMuscle(m,scheme.reps);
        exercises.push({name:ex.n,muscle:m,cue:ex.c,sets:scheme.sets,reps,
          weight:suggestStartWeight(ex,m,reps),rest:scheme.rest,priority:true});
      });
    }
    const trimmed=exercises.slice(0,maxEx);
    const out=[warmupFor(d),...trimmed];
    if(wantsCardio)out.push(cardioFinisher());
    return {name:d.name,exercises:out};
  })};
  // weekly schedule — first training day starts TODAY (no opening rest day)
  program.baseSchedule=scheduleFor(program.split.length,true);
  program.schedule=JSON.parse(JSON.stringify(program.baseSchedule));
  program.overrides={};
  return program;
}
// Build a 7-day schedule. If startToday, the soonest train day is today's weekday.
function scheduleFor(trainDays,startToday){
  const spread={2:[0,3],3:[0,2,4],4:[0,1,3,4],5:[0,1,2,4,5],6:[0,1,2,3,4,5],7:[0,1,2,3,4,5,6]}[trainDays]||[0,2,4];
  const today=(new Date().getDay()+6)%7; // Mon=0
  const sched=[];
  for(let i=0;i<7;i++)sched.push({type:'rest'});
  // place training days starting from today, spaced like the spread pattern
  const gaps=spread.map((v,i)=>i===0?0:v-spread[i-1]);
  let cursor=startToday?today:spread[0];
  let idx=0;
  for(let k=0;k<trainDays;k++){
    sched[cursor%7]={type:'train',idx:idx++};
    cursor+= (gaps[k+1]||Math.round(7/trainDays));
  }
  return sched;
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
const GEMINI_MODEL='gemini-2.5-flash';
const GEMINI_URL='https://generativelanguage.googleapis.com/v1beta/models/'+GEMINI_MODEL+':generateContent?key=';
const COACH_PERSONA=`You are a real strength coach texting with your client — talk like an actual human, not an AI assistant. Warm, direct, encouraging, a little informal. Use plain language a normal person uses at the gym. NEVER say you're an AI, never give disclaimers, never use bullet points or headers in chat — just talk. Keep it to 2-4 sentences unless they ask for detail. You know your stuff (progressive overload, recovery, rep ranges, form) but you explain it simply. You're honest: if they should drop a weight, deload, rest, or fix form, you tell them straight — kindly. Give concrete, doable advice like "drop to a weight where the last two reps are hard but clean, then build back up." Never invent numbers — work from what they tell you.`;
async function geminiCall(prompt, imageB64){
  if(!S.settings.geminiKey) throw new Error('no key');
  const parts=[{text:prompt}];
  if(imageB64)parts.push({inline_data:{mime_type:'image/jpeg',data:imageB64}});
  let r;
  try{
    r=await fetch(GEMINI_URL+S.settings.geminiKey,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({systemInstruction:{parts:[{text:COACH_PERSONA}]},contents:[{parts}],generationConfig:{temperature:0.7,maxOutputTokens:700}})});
  }catch(e){throw new Error('network');}
  if(r.status===400||r.status===403)throw new Error('badkey');
  if(r.status===429)throw new Error('limit');
  if(!r.ok)throw new Error('gemini '+r.status);
  const d=await r.json();
  return d.candidates?.[0]?.content?.parts?.[0]?.text||'';
}
// human-friendly explanation of why an AI call failed
function aiErrorMsg(e){
  const m=(e&&e.message)||'';
  if(m==='no key')return 'Add your free Gemini key in Settings → AI first.';
  if(m==='badkey')return 'That Gemini key looks invalid. Re-copy it from aistudio.google.com.';
  if(m==='limit')return 'Gemini free limit hit for now — try again in a bit.';
  if(m==='network')return 'No connection to Gemini. Check your internet and try again.';
  return 'Coach is unavailable right now. Try again shortly.';
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
  if(!S.program){go('workout');return;}
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
    const muscles=tw.exercises?tw.exercises.filter(e=>!e.warmup&&!e.cardio).map(e=>MUSCLE_LABELS[e.muscle]).filter((v,i,a)=>a.indexOf(v)===i).slice(0,4).join(', '):'';
    h+=`<div class="card" style="border-color:var(--acc2)">
      <div class="day-pill">Today · ${tw.name}</div>
      <div style="font-size:13px;color:var(--txt2);font-weight:600;margin-bottom:14px">${tw.exercises?tw.exercises.filter(e=>!e.warmup&&!e.cardio).length:0} exercises + warm-up · ${muscles}</div>
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
    <div class="stat" onclick="explainCalories()" style="cursor:pointer"><div class="v">${tdee.toLocaleString()}</div><div class="l">Daily Calories ⓘ</div></div>
  </div>`;

  if(S.program.coachNote){
    h+=`<div class="coach"><div class="cl">⚡ Coach</div><p>${S.program.coachNote}</p></div>`;
  }

  // Talk to coach
  h+=`<button class="btn ghost" style="width:100%;margin-bottom:14px" onclick="openCoachChat()">💬 Ask your coach anything</button>`;

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
  const aiBtn=S.settings.geminiKey?`<button class="btn" style="margin-top:12px" onclick="muscleAIDetail('${m}')">⚡ Get detailed AI breakdown</button>`:'';
  modal(`<h3>${MUSCLE_LABELS[m]||m}</h3>
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
      <span class="tier tier-${tier}" style="font-size:12px;font-weight:800;padding:4px 11px;border-radius:20px">${tier}</span>
      <div class="rank-bar" style="flex:1;margin:0"><i style="width:${Math.min(100,lvl*20)}%"></i></div>
    </div>
    <p style="color:var(--txt2);line-height:1.55">${desc}</p>
    <div id="muscleAI"></div>
    ${aiBtn}
    <button class="btn ghost" style="margin-top:10px" onclick="closeModal()">Got it</button>`);
}
async function muscleAIDetail(m){
  const box=$('#muscleAI');box.innerHTML='<p class="small" style="margin-top:12px">Coach is analyzing…</p>';
  const lvl=(muscleStrength()[m]||0);
  const lifts=Object.entries(S.lifts).filter(([k,v])=>v&&!v.unknown&&v.weight&&(LIFT_MUSCLES[k]||[]).includes(m)).map(([k,v])=>`${k} ${v.weight}x${v.reps}`).join(', ')||'no direct lifts logged';
  try{
    const fb=await geminiCall(`Athlete: ${S.profile.age}yo ${S.profile.sex}, ${S.profile.weight}lb, experience=${S.profile.experience}, goal=${S.profile.goal}. Their ${MUSCLE_LABELS[m]} ranks around "${TIERS[Math.min(5,Math.round(lvl))]}". Relevant lifts: ${lifts}. In 3-4 sentences: how developed is this muscle for someone their size, what's likely holding it back, and the single best thing to do next. Be specific and honest.`);
    box.innerHTML=`<div class="coach" style="margin-top:12px"><div class="cl">⚡ Coach</div><p>${fb.replace(/\n/g,'<br>')}</p></div>`;
  }catch(e){box.innerHTML=`<p class="small" style="margin-top:12px;color:var(--amber)">${aiErrorMsg(e)}</p>`;}
}
// explain the daily-calorie number in plain language
function explainCalories(){
  const p=S.profile;const kg=(+p.weight||0)*0.4536;const cm=((+p.heightFt||0)*12+(+p.heightIn||0))*2.54;const age=+p.age||25;
  const bmr=Math.round(p.sex==='female'?(10*kg+6.25*cm-5*age-161):(10*kg+6.25*cm-5*age+5));
  const tdee=calcTDEE();const target=calorieTarget();
  const actName={2:'lightly active (2 days/wk)',3:'lightly active',4:'moderately active',5:'very active',6:'very active',7:'extremely active'}[+p.days]||'active';
  const goalLine=p.goal==='bulk'?`Because you're <b>bulking</b>, I add ~350 on top → <b>${target.toLocaleString()}</b> to build muscle.`
    :p.goal==='cut'?`Because you're <b>cutting</b>, I subtract ~450 → <b>${target.toLocaleString()}</b> to lose fat while keeping muscle.`
    :`Since you're <b>maintaining</b>, your target stays at <b>${target.toLocaleString()}</b>.`;
  modal(`<h3>Why ${tdee.toLocaleString()} calories?</h3>
    <div style="color:var(--txt2);line-height:1.6">
    <p style="margin-bottom:10px">Your body burns calories even at rest. Here's the math:</p>
    <p style="margin-bottom:8px">• <b style="color:var(--txt)">Base (BMR):</b> ${bmr.toLocaleString()} cal — what you'd burn doing nothing all day, based on your age (${age}), height, weight, and sex.</p>
    <p style="margin-bottom:8px">• <b style="color:var(--txt)">Activity:</b> you're ${actName}, so I multiply that base up to <b>${tdee.toLocaleString()}</b> — your real daily burn.</p>
    <p style="margin-bottom:8px">• <b style="color:var(--txt)">Your goal:</b> ${goalLine}</p>
    <p style="margin-top:12px;font-size:13px">At ${age}, your metabolism runs fast — this number is normal for a healthy teen, not high. Eat below it to lose, above it to gain.</p>
    </div>
    <button class="btn ghost" style="margin-top:16px" onclick="closeModal()">Got it</button>`);
}
// ---- AI coach chat (text + optional photo) ----
let coachChatLog=[];
function openCoachChat(){
  if(!S.settings.geminiKey){modal(`<h3>💬 Coach Chat</h3><p style="color:var(--txt2);line-height:1.5">Add your free Gemini key in Settings → AI to chat with your coach. Then you can ask things like "this exercise left me out of breath" or "how do I lose face fat" and attach a photo.</p><button class="btn" style="margin-top:16px" onclick="closeModal();openSettings()">Open Settings</button>`);return;}
  renderCoachChat();
}
// renders the apply button for a coach action (change/swap/add/remove)
function actionButton(a,mi,ai){
  const done=a.done?' ✓ done':'';
  const dis=a.done?'opacity:.5':'';
  let label;
  if(a.kind==='change')label=`Set ${a.name} → ${a.weight}lb`;
  else if(a.kind==='swap')label=`Swap ${a.name} → ${a.to}`;
  else if(a.kind==='add')label=`Add ${a.to}`;
  else if(a.kind==='remove')label=`Remove ${a.name}`;
  else return '';
  return `<div style="margin-top:6px"><button class="btn sm" style="font-size:12px;padding:7px 12px;${dis}" ${a.done?'disabled':''} onclick="runCoachAction(${mi},${ai})">✓ ${label}${done}</button></div>`;
}
function runCoachAction(mi,ai){
  const a=coachChatLog[mi]&&coachChatLog[mi].actions&&coachChatLog[mi].actions[ai];
  if(!a||a.done)return;
  if(a.kind==='change')applyCoachChange(a.name,a.weight);
  else if(a.kind==='swap')applyCoachSwap(a.name,a.to);
  else if(a.kind==='add')applyCoachAdd(a.muscle,a.to);
  else if(a.kind==='remove')applyCoachRemove(a.name);
  a.done=true;
  renderCoachChat();
}
function renderCoachChat(){
  const msgs=coachChatLog.map((m,mi)=>m.role==='user'
    ?`<div style="text-align:right;margin:8px 0"><span style="display:inline-block;background:var(--acc);color:#0a0a0b;padding:9px 13px;border-radius:14px 14px 4px 14px;font-weight:600;max-width:85%;text-align:left">${m.text}${m.img?' 📷':''}</span></div>`
    :`<div style="margin:8px 0"><span style="display:inline-block;background:var(--card2);padding:9px 13px;border-radius:14px 14px 14px 4px;max-width:85%">${m.text.replace(/\n/g,'<br>')}</span>${m.actions?m.actions.map((a,ai)=>actionButton(a,mi,ai)).join(''):''}</div>`
  ).join('')||'<p class="small" style="text-align:center;padding:20px">Talk to your coach like a real person — "this left me out of breath", "I don\'t have a bench", "my shoulder feels off", "give me an extra ab move". Attach a photo for form or physique feedback. When the advice means changing your plan, you\'ll get a button to apply it.</p>';
  modal(`<h3>💬 Coach Chat</h3>
    <div id="chatScroll" style="max-height:46vh;overflow-y:auto;margin-bottom:12px">${msgs}</div>
    <div id="chatImgPreview"></div>
    <div class="addw">
      <input class="inp" id="chatInput" placeholder="Message your coach…" style="flex:1" onkeydown="if(event.key==='Enter')sendCoachChat()">
      <button class="btn ghost sm" style="flex:0 0 auto" onclick="$('#chatImgInput').click()">📷</button>
      <button class="btn sm" style="flex:0 0 auto" onclick="sendCoachChat()">Send</button>
    </div>
    <input type="file" id="chatImgInput" accept="image/*" style="display:none" onchange="stageChatImg(this)">`);
  const sc=$('#chatScroll');if(sc)sc.scrollTop=sc.scrollHeight;
}
let stagedChatImg=null;
function stageChatImg(input){
  const f=input.files[0];if(!f)return;
  const rd=new FileReader();rd.onload=()=>{stagedChatImg=rd.result.split(',')[1];
    $('#chatImgPreview').innerHTML=`<div class="small" style="margin-bottom:8px;color:var(--acc)">📷 Photo attached — add a question and send</div>`;};
  rd.readAsDataURL(f);
}
async function sendCoachChat(){
  const inp=$('#chatInput');const text=inp.value.trim();
  if(!text&&!stagedChatImg)return;
  coachChatLog.push({role:'user',text:text||'(photo)',img:!!stagedChatImg});
  const img=stagedChatImg;stagedChatImg=null;
  renderCoachChat();
  coachChatLog.push({role:'coach',text:'…thinking'});renderCoachChat();
  // give the coach the current program so its advice is specific to their lifts
  const prog=S.program?S.program.split.map(d=>d.name+': '+d.exercises.filter(e=>!e.warmup&&!e.cardio).map(e=>`${e.name} ${e.weight!=null?e.weight+'lb':'bodyweight'}×${e.reps}`).join(', ')).join(' | '):'no program yet';
  // exercises they can actually do with their gear (so swaps/adds are realistic)
  const canDo=availableExerciseNames();
  const history=coachChatLog.slice(-7,-1).map(m=>`${m.role==='user'?'Client':'You'}: ${m.text}`).join('\n');
  const ctx=`${history?history+'\n':''}Client just said: "${text}".

Their profile: ${S.profile.age}yo ${S.profile.sex}, ${S.profile.weight}lb, goal=${S.profile.goal}, experience=${S.profile.experience}.
Their gym: ${(S.profile.equipment||[]).join(', ')||'bodyweight only'}${S.profile.barbellMax?` (barbell loads up to ${S.profile.barbellMax}lb)`:''}.
Their current program: ${prog}.
Exercises they CAN do with their equipment: ${canDo.join(', ')}.

Reply as their coach (human, conversational, 2-4 sentences). React like a real coach to how things felt or what they're missing, and tell them what to do.

IMPORTANT — when your advice means actually editing their program, append the matching directive(s) on their OWN new line at the very end. Only use exercise names from the "CAN do" list for new exercises. Use the exact current name from their program for the old/removed one. Omit all directives if none apply.
- Change a weight: [[CHANGE:exercise name|newWeightLb]]
- Swap one exercise for another: [[SWAP:current exercise|new exercise]]
- Add an exercise: [[ADD:muscle|new exercise]]  (muscle one of: chest,back,quads,hamstrings,glutes,frontDelt,sideDelt,rearDelt,biceps,triceps,forearms,abs,calves)
- Remove an exercise: [[REMOVE:exercise name]]
Examples: [[SWAP:Barbell Bench Press|Push-up]]   [[ADD:abs|Plank]]   [[REMOVE:Standing Calf Raise]]`;
  try{
    const raw=await geminiCall(ctx,img);
    // pull out any directives
    const actions=[];
    let clean=(raw||'')
      .replace(/\[\[CHANGE:([^|\]]+)\|(\d+(?:\.\d+)?)\]\]/g,(m,name,w)=>{actions.push({kind:'change',name:name.trim(),weight:+w});return '';})
      .replace(/\[\[SWAP:([^|\]]+)\|([^\]]+)\]\]/g,(m,oldN,newN)=>{actions.push({kind:'swap',name:oldN.trim(),to:newN.trim()});return '';})
      .replace(/\[\[ADD:([^|\]]+)\|([^\]]+)\]\]/g,(m,mus,newN)=>{actions.push({kind:'add',muscle:mus.trim(),to:newN.trim()});return '';})
      .replace(/\[\[REMOVE:([^\]]+)\]\]/g,(m,name)=>{actions.push({kind:'remove',name:name.trim()});return '';})
      .trim();
    coachChatLog[coachChatLog.length-1]={role:'coach',text:clean||'Got it.',actions:actions.length?actions:null};
  }catch(e){coachChatLog[coachChatLog.length-1]={role:'coach',text:aiErrorMsg(e)};}
  renderCoachChat();
}
// every exercise name the user can actually perform with their current equipment
function availableExerciseNames(){
  const eq=(S.profile.equipment||[]).concat('bodyweight');
  const hated=(S.profile.hated||'').toLowerCase().split(/[,;]/).map(h=>h.trim()).filter(Boolean);
  const out=[];
  for(const m in EXLIB){EXLIB[m].forEach(x=>{
    if(x.eq.some(e=>eq.includes(e)) && (!x.req||x.req.some(r=>eq.includes(r))) && !hated.some(h=>x.n.toLowerCase().includes(h)))out.push(x.n);
  });}
  return [...new Set(out)];
}
// find an exercise's library entry + which muscle it belongs to
function findExercise(name){
  const low=name.toLowerCase();
  const eq=(S.profile.equipment||[]).concat('bodyweight');
  const doable=x=> x.eq.some(e=>eq.includes(e)) && (!x.req||x.req.some(r=>eq.includes(r)));
  // exact match — prefer a doable one if there are duplicates
  let exactDoable=null, exactAny=null;
  for(const m in EXLIB){for(const x of EXLIB[m]){
    if(x.n.toLowerCase()===low){ if(doable(x))return {ex:x,muscle:m}; exactAny=exactAny||{ex:x,muscle:m}; }
  }}
  if(exactAny)return exactAny;
  // fuzzy contains — again prefer doable
  for(const m in EXLIB){for(const x of EXLIB[m]){
    if((x.n.toLowerCase().includes(low)||low.includes(x.n.toLowerCase())) && doable(x))return {ex:x,muscle:m};
  }}
  for(const m in EXLIB){const hit=EXLIB[m].find(x=>x.n.toLowerCase().includes(low)||low.includes(x.n.toLowerCase()));if(hit)return {ex:hit,muscle:m};}
  return null;
}
// apply a coach-suggested weight change into the live program
function applyCoachChange(name,weight){
  if(!S.program)return;
  let hit=0;
  S.program.split.forEach(d=>d.exercises.forEach(e=>{
    if(!e.warmup && e.name.toLowerCase()===name.toLowerCase()){e.weight=weight;hit++;}
  }));
  if(!hit){ // fuzzy: first exercise containing the words
    const key=name.toLowerCase().split(' ')[0];
    S.program.split.forEach(d=>d.exercises.forEach(e=>{if(!hit&&!e.warmup&&e.name.toLowerCase().includes(key)){e.weight=weight;hit++;}}));
  }
  save();
  toast(hit?`Updated ${name} to ${weight}lb`:'Could not find that exercise','good');
  if($('#s_workout'))try{renderWorkout();}catch(e){}
}
// swap an exercise for a different one everywhere it appears
function applyCoachSwap(oldName,newName){
  if(!S.program)return;
  const found=findExercise(newName);
  if(!found){toast('Could not find '+newName,'bad');return;}
  let hit=0;
  S.program.split.forEach(d=>d.exercises.forEach((e,i)=>{
    if(!e.warmup&&!e.cardio && (e.name.toLowerCase()===oldName.toLowerCase()||e.name.toLowerCase().includes(oldName.toLowerCase().split(' ')[0]))){
      const reps=e.reps;
      d.exercises[i]={name:found.ex.n,muscle:found.muscle,cue:found.ex.c,
        sets:e.sets,reps,weight:suggestStartWeight(found.ex,found.muscle,reps),
        rest:e.rest,priority:e.priority};
      hit++;
    }
  }));
  save();
  toast(hit?`Swapped to ${found.ex.n}`:'Could not find that exercise','good');
  if($('#s_workout'))try{renderWorkout();}catch(e){}
}
// add a new exercise to the day(s) that train the given muscle
function applyCoachAdd(muscle,newName){
  if(!S.program)return;
  const found=findExercise(newName);
  if(!found){toast('Could not find '+newName,'bad');return;}
  const reps=repsForMuscle(found.muscle,S.program.scheme.reps);
  const newEx={name:found.ex.n,muscle:found.muscle,cue:found.ex.c,
    sets:S.program.scheme.sets,reps,weight:suggestStartWeight(found.ex,found.muscle,reps),
    rest:S.program.scheme.rest,priority:false};
  // add to the first day that already trains this muscle, else the first day
  let target=S.program.split.find(d=>d.exercises.some(e=>e.muscle===found.muscle&&!e.warmup))||S.program.split[0];
  // insert before any cardio finisher
  const ci=target.exercises.findIndex(e=>e.cardio);
  if(ci>=0)target.exercises.splice(ci,0,newEx); else target.exercises.push(newEx);
  save();
  toast(`Added ${found.ex.n} to ${target.name}`,'good');
  if($('#s_workout'))try{renderWorkout();}catch(e){}
}
// remove an exercise from the program
function applyCoachRemove(name){
  if(!S.program)return;
  let hit=0;
  S.program.split.forEach(d=>{
    const before=d.exercises.length;
    d.exercises=d.exercises.filter(e=>e.warmup||e.cardio||!(e.name.toLowerCase()===name.toLowerCase()||e.name.toLowerCase().includes(name.toLowerCase().split(' ')[0])));
    hit+=before-d.exercises.length;
  });
  save();
  toast(hit?`Removed ${name}`:'Could not find that exercise','good');
  if($('#s_workout'))try{renderWorkout();}catch(e){}
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
  const base='#26262c';
  return `<div class="mmap"><svg viewBox="0 0 140 280" xmlns="http://www.w3.org/2000/svg">
    <!-- head + neck -->
    <ellipse cx="70" cy="22" rx="13" ry="15" fill="${base}"/>
    <path d="M63 35 h14 v8 h-14 Z" fill="${base}"/>
    <!-- traps -->
    <path d="M48 44 Q70 36 92 44 Q86 52 70 50 Q54 52 48 44 Z" fill="${c('traps')}" ${tap('traps')}/>
    <!-- delts (rounded caps) -->
    <ellipse cx="42" cy="58" rx="13" ry="12" fill="${c('frontDelt')}" ${tap('frontDelt')}/>
    <ellipse cx="98" cy="58" rx="13" ry="12" fill="${c('frontDelt')}" ${tap('frontDelt')}/>
    <!-- chest (two pecs) -->
    <path d="M55 50 Q70 47 70 49 L70 78 Q60 84 50 76 Q48 60 55 50 Z" fill="${c('chest')}" ${tap('chest')}/>
    <path d="M85 50 Q70 47 70 49 L70 78 Q80 84 90 76 Q92 60 85 50 Z" fill="${c('chest')}" ${tap('chest')}/>
    <!-- biceps -->
    <path d="M30 62 Q26 76 30 92 L40 90 Q42 74 40 64 Q35 60 30 62 Z" fill="${c('biceps')}" ${tap('biceps')}/>
    <path d="M110 62 Q114 76 110 92 L100 90 Q98 74 100 64 Q105 60 110 62 Z" fill="${c('biceps')}" ${tap('biceps')}/>
    <!-- forearms -->
    <path d="M28 94 Q26 108 30 124 L38 122 Q40 106 38 94 Z" fill="${c('forearms')}" ${tap('forearms')}/>
    <path d="M112 94 Q114 108 110 124 L102 122 Q100 106 102 94 Z" fill="${c('forearms')}" ${tap('forearms')}/>
    <!-- abs (6-pack grid) -->
    <g ${tap('abs')}>
      <rect x="58" y="82" width="11" height="11" rx="2" fill="${c('abs')}"/>
      <rect x="71" y="82" width="11" height="11" rx="2" fill="${c('abs')}"/>
      <rect x="58" y="95" width="11" height="11" rx="2" fill="${c('abs')}"/>
      <rect x="71" y="95" width="11" height="11" rx="2" fill="${c('abs')}"/>
      <rect x="58" y="108" width="11" height="12" rx="2" fill="${c('abs')}"/>
      <rect x="71" y="108" width="11" height="12" rx="2" fill="${c('abs')}"/>
    </g>
    <!-- obliques -->
    <path d="M52 84 Q50 104 56 122 L58 120 Q56 100 57 84 Z" fill="${c('abs')}" opacity="0.6" ${tap('abs')}/>
    <path d="M88 84 Q90 104 84 122 L82 120 Q84 100 83 84 Z" fill="${c('abs')}" opacity="0.6" ${tap('abs')}/>
    <!-- quads -->
    <path d="M52 126 Q50 160 56 192 L66 190 Q68 154 66 126 Q59 122 52 126 Z" fill="${c('quads')}" ${tap('quads')}/>
    <path d="M88 126 Q90 160 84 192 L74 190 Q72 154 74 126 Q81 122 88 126 Z" fill="${c('quads')}" ${tap('quads')}/>
    <!-- calves -->
    <path d="M55 196 Q52 222 58 246 L66 244 Q67 220 65 196 Z" fill="${c('calves')}" ${tap('calves')}/>
    <path d="M85 196 Q88 222 82 246 L74 244 Q73 220 75 196 Z" fill="${c('calves')}" ${tap('calves')}/>
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
  // no program yet (interrupted onboarding) — offer to build one
  if(!S.program||!S.program.split){
    $('#s_workout').innerHTML=`<div class="page"><div class="topbar"><div><div class="sub">Training</div><h1>Workout</h1></div></div>
      <div class="card" style="text-align:center;padding:28px">
        <div style="font-size:30px">🏗️</div>
        <div class="disp" style="font-size:20px;margin-top:6px">No program yet</div>
        <p class="small" style="margin-top:6px">Let's build your training plan from your profile.</p>
        <button class="btn" style="margin-top:14px" onclick="S.program=buildLocalProgram();save();renderWorkout();">Build My Program</button>
      </div></div>`;
    return;
  }
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
  const workCount=d.exercises.filter(e=>!e.warmup&&!e.cardio).length;
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
    if(e.cardio){
      h+=`<div class="ex-card" style="border-color:var(--acc2)"><div class="ex-head">
        <div><div class="nm">🏃 ${e.name}</div><div class="meta">${e.reps} · optional finisher</div></div>
        <span class="ex-musc">Cardio</span></div></div>`;
      return;
    }
    const loadStr=e.weight!=null?`start ${e.weight}lb`:'bodyweight / your load';
    h+=`<div class="ex-card"><div class="ex-head">
      <div><div class="nm">${e.name}${e.priority?' <span style="color:var(--acc);font-size:12px">★ priority</span>':''}</div>
        <div class="meta">${e.sets} × ${e.reps} reps · <button onclick="pickWeight('${d.name.replace(/'/g,"")}','${e.name.replace(/'/g,"")}')" style="color:var(--acc);font-weight:700;text-decoration:underline">${loadStr}</button></div></div>
      <button class="ex-musc" onclick="showForm('${e.name.replace(/'/g,"")}','${e.muscle}')">${MUSCLE_LABELS[e.muscle]}</button>
    </div></div>`;
  });
  $('#dayPreview').innerHTML=h;
}
// let the user pick the exact weight they want for an exercise (only weights they own + custom)
function pickWeight(dayName,exName){
  const day=S.program.split.find(d=>d.name===dayName);if(!day)return;
  const ex=day.exercises.find(e=>e.name===exName);if(!ex)return;
  const avail=availableWeights({n:ex.name})||[];
  const chips=avail.map(w=>`<button class="w${ex.weight===w?' on':''}" onclick="setExWeight('${dayName.replace(/'/g,"")}','${exName.replace(/'/g,"")}',${w})">${w}</button>`).join('');
  modal(`<h3>${ex.name}</h3>
    <p style="color:var(--txt2);margin-bottom:12px">Pick the weight you want to work with. I'll only show what you own — tap one, or type your own below.</p>
    ${avail.length?`<div class="winv">${chips}</div>`:'<p class="small" style="margin-bottom:12px">This is a bodyweight / improvised move — set your load when you log.</p>'}
    <div class="addw" style="margin-top:12px">
      <input class="inp" id="customExW" type="number" inputmode="decimal" placeholder="Custom weight (lb)" style="flex:1">
      <button class="btn sm" style="flex:0 0 auto" onclick="setExWeight('${dayName.replace(/'/g,"")}','${exName.replace(/'/g,"")}', +$('#customExW').value)">Set</button>
    </div>
    ${ex.weight!=null?`<button class="btn ghost sm" style="width:100%;margin-top:10px" onclick="setExWeight('${dayName.replace(/'/g,"")}','${exName.replace(/'/g,"")}',null)">Make it bodyweight</button>`:''}`);
}
function setExWeight(dayName,exName,w){
  const day=S.program.split.find(d=>d.name===dayName);if(!day)return;
  const ex=day.exercises.find(e=>e.name===exName);if(!ex)return;
  if(w===null){ex.weight=null;}
  else{if(!w||w<=0){toast('Enter a weight','bad');return;}ex.weight=w;}
  save();closeModal();
  const idx=S.program.split.indexOf(day);previewDay(idx);
  toast('Weight updated','good');
}
function toggleFav(name){const i=S.favorites.indexOf(name);if(i>=0)S.favorites.splice(i,1);else S.favorites.push(name);save();previewDay(S.program.split.findIndex(d=>d.name===name));toast(i>=0?'Removed favorite':'Added to favorites ★');}

function showForm(name,muscle){
  const ex=Object.values(EXLIB).flat().find(x=>x.n===name);
  const yt='https://www.youtube.com/results?search_query='+encodeURIComponent(name+' proper form how to');
  modal(`<h3>${name}</h3>
    <div style="background:var(--bg3);border-radius:14px;padding:18px;text-align:center;margin-bottom:14px">
      ${formAnimation(name)}
      <p class="small" style="margin-top:6px">Animated form guide — watch the motion loop</p>
    </div>
    <a href="${yt}" target="_blank" rel="noopener" class="btn ghost" style="display:block;text-align:center;margin-bottom:14px;text-decoration:none">▶ Watch real demos on YouTube</a>
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
  // slower, smooth ease so the motion is readable
  const DUR='2.6s';
  const SP=`dur="${DUR}" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.5;1" keySplines="0.42 0 0.58 1;0.42 0 0.58 1"`;
  const open='<svg viewBox="0 0 160 170" style="width:150px;height:160px">';
  const close='</svg>';
  const ground=(y=158)=>`<line x1="20" y1="${y}" x2="140" y2="${y}" stroke="var(--line)" stroke-width="2.5"/>`;
  const skin='#aab0b8', limb='#8b919a', acc='var(--acc)', jt='#6f757e';
  // a "limb" = thick rounded line between two points
  const seg=(x1,y1,x2,y2,w=9,col=limb)=>`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${col}" stroke-width="${w}" stroke-linecap="round"/>`;
  const joint=(x,y,r=4)=>`<circle cx="${x}" cy="${y}" r="${r}" fill="${jt}"/>`;
  const head=(x,y,r=12)=>`<circle cx="${x}" cy="${y}" r="${r}" fill="${skin}"/>`;
  // a loaded barbell drawn horizontally, centered at (cx,y)
  const barbell=(cx,y,half=34)=>`<line x1="${cx-half}" y1="${y}" x2="${cx+half}" y2="${y}" stroke="${acc}" stroke-width="5"/>
    <rect x="${cx-half-4}" y="${y-9}" width="7" height="18" rx="2" fill="${acc}"/><rect x="${cx+half-3}" y="${y-9}" width="7" height="18" rx="2" fill="${acc}"/>`;
  // dumbbell in a hand at (x,y)
  const db=(x,y)=>`<rect x="${x-9}" y="${y-4}" width="18" height="8" rx="3" fill="${acc}"/><rect x="${x-12}" y="${y-7}" width="5" height="14" rx="2" fill="${acc}"/><rect x="${x+7}" y="${y-7}" width="5" height="14" rx="2" fill="${acc}"/>`;
  // up/down or in/out motion arrow + phase label
  const arrowV=(x,top,bot)=>`<g opacity="0.9"><line x1="${x}" y1="${top}" x2="${x}" y2="${bot}" stroke="${acc}" stroke-width="2" stroke-dasharray="3 3"/>
    <path d="M${x-4} ${top+5} L${x} ${top} L${x+4} ${top+5}" fill="none" stroke="${acc}" stroke-width="2"/>
    <path d="M${x-4} ${bot-5} L${x} ${bot} L${x+4} ${bot-5}" fill="none" stroke="${acc}" stroke-width="2"/></g>`;
  const label=t=>`<text x="80" y="14" text-anchor="middle" fill="var(--txt3)" font-size="11" font-weight="700" font-family="system-ui">${t}</text>`;

  switch(pat){
    /* ---- horizontal press: bench / push-up (side view, lying down) ---- */
    case 'press_h': return open+label('Lower to chest → press up')+
      `<rect x="34" y="120" width="92" height="9" rx="4" fill="var(--line)"/>
       ${head(40,112)}
       ${seg(50,116,92,116,15,skin)}
       ${seg(92,116,108,128,9)}${seg(108,128,124,128,9)}
       ${arrowV(80,70,104)}
       <g><animateTransform attributeName="transform" type="translate" values="0 0;0 26;0 0" ${SP}/>
         ${seg(70,116,70,82,8)}${joint(70,82)}
         ${barbell(70,78,30)}</g>`+close;

    /* ---- vertical press: overhead / shoulder press (standing, front) ---- */
    case 'press_v': return open+ground()+label('Press overhead → lower to shoulders')+
      `${seg(72,150,72,108,10)}${seg(88,150,88,108,10)}
       ${seg(72,108,80,96,11)}${seg(88,108,80,96,11)}
       ${head(80,84)}
       ${arrowV(122,58,96)}
       <g><animateTransform attributeName="transform" type="translate" values="0 0;0 -34;0 0" ${SP}/>
         ${seg(64,98,58,84,8)}${seg(96,98,102,84,8)}
         ${seg(58,84,72,84,8)}${seg(102,84,88,84,8)}
         ${barbell(80,80,30)}${joint(58,84)}${joint(102,84)}</g>`+close;

    /* ---- squat (front, bar on back) ---- */
    case 'squat': return open+ground()+label('Sit down → drive up')+
      `${arrowV(128,84,120)}
       <g><animateTransform attributeName="transform" type="translate" values="0 0;0 24;0 0" ${SP}/>
         ${head(80,40)}${seg(72,52,72,86,11)}${seg(88,52,88,86,11)}
         ${seg(62,58,72,54,8)}${seg(98,58,88,54,8)}
         ${barbell(80,52,32)}</g>
       <g><animateTransform attributeName="transform" type="rotate" values="0 72 88;-22 72 88;0 72 88" ${SP}/>${seg(72,88,66,120,11)}</g>
       <g><animateTransform attributeName="transform" type="rotate" values="0 88 88;22 88 88;0 88 88" ${SP}/>${seg(88,88,94,120,11)}</g>
       ${seg(66,120,62,150,11)}${seg(94,120,98,150,11)}${joint(72,88)}${joint(88,88)}`+close;

    /* ---- hinge: deadlift / RDL (side view, bend at hips) ---- */
    case 'hinge': return open+ground()+label('Hinge at hips → stand tall')+
      `${seg(80,150,80,96,11)}
       <g><animateTransform attributeName="transform" type="rotate" values="0 80 96;58 80 96;0 80 96" ${SP}/>
         ${seg(80,96,80,56,12)}${head(80,46)}
         ${seg(80,72,80,108,8)}${db(80,110)}</g>
       ${joint(80,96)}${seg(80,150,72,150,11)}`+close;

    /* ---- row (side view, bent over, pull elbow back) ---- */
    case 'row': return open+ground()+label('Pull weight to hip → lower')+
      `${seg(80,150,80,108,11)}${joint(80,108)}
       <g transform="rotate(62 80 100)">${seg(80,100,80,58,12)}${head(80,48)}</g>
       ${arrowV(118,96,118)}
       <g><animateTransform attributeName="transform" type="translate" values="0 0;0 -22;0 0" ${SP}/>
         ${seg(58,86,58,116,8)}${db(58,118)}</g>`+close;

    /* ---- pulldown / pull-up (front, pull bar down) ---- */
    case 'pulldown': return open+label('Pull down to chest → control up')+
      `${seg(72,150,72,108,10)}${seg(88,150,88,108,10)}
       ${seg(72,108,80,94,11)}${seg(88,108,80,94,11)}${head(80,82)}
       ${arrowV(124,40,86)}
       <g><animateTransform attributeName="transform" type="translate" values="0 0;0 30;0 0" ${SP}/>
         ${seg(60,92,54,52,8)}${seg(100,92,106,52,8)}
         ${barbell(80,48,36)}${joint(54,52)}${joint(106,52)}</g>`+close;

    /* ---- curl (front, rotate forearms up) ---- */
    case 'curl': return open+ground()+label('Curl up → lower slow')+
      `${seg(72,150,72,104,10)}${seg(88,150,88,104,10)}
       ${head(80,42)}${seg(72,54,72,98,12)}${seg(88,54,88,98,12)}
       ${seg(64,58,72,56,8)}${seg(96,58,88,56,8)}
       ${arrowV(40,70,104)}
       <g><animateTransform attributeName="transform" type="rotate" values="0 64 100;-130 64 100;0 64 100" ${SP}/>
         ${seg(64,100,64,124,8)}${db(64,126)}${joint(64,100)}</g>
       <g><animateTransform attributeName="transform" type="rotate" values="0 96 100;130 96 100;0 96 100" ${SP}/>
         ${seg(96,100,96,124,8)}${db(96,126)}${joint(96,100)}</g>`+close;

    /* ---- lateral raise (front, raise arms out) ---- */
    case 'lateral': return open+ground()+label('Raise to shoulder height → lower')+
      `${seg(72,150,72,104,10)}${seg(88,150,88,104,10)}
       ${head(80,42)}${seg(72,54,72,98,12)}${seg(88,54,88,98,12)}
       <g><animateTransform attributeName="transform" type="rotate" values="80 72 60;0 72 60;80 72 60" ${SP}/>
         ${seg(72,60,44,60,8)}${db(40,60)}${joint(72,60)}</g>
       <g><animateTransform attributeName="transform" type="rotate" values="-80 88 60;0 88 60;-80 88 60" ${SP}/>
         ${seg(88,60,116,60,8)}${db(120,60)}${joint(88,60)}</g>`+close;

    /* ---- fly (front, hug motion) ---- */
    case 'fly': return open+ground()+label('Open wide → squeeze together')+
      `${seg(72,150,72,104,10)}${seg(88,150,88,104,10)}
       ${head(80,42)}${seg(72,54,72,98,12)}${seg(88,54,88,98,12)}
       <g><animateTransform attributeName="transform" type="rotate" values="-75 72 60;-15 72 60;-75 72 60" ${SP}/>
         ${seg(72,60,40,60,8)}${db(36,60)}${joint(72,60)}</g>
       <g><animateTransform attributeName="transform" type="rotate" values="75 88 60;15 88 60;75 88 60" ${SP}/>
         ${seg(88,60,120,60,8)}${db(124,60)}${joint(88,60)}</g>`+close;

    /* ---- tricep pushdown / extension (front, extend forearms down) ---- */
    case 'pushdown': return open+ground()+label('Extend down → control up')+
      `${seg(72,150,72,104,10)}${seg(88,150,88,104,10)}
       ${head(80,42)}${seg(72,54,72,98,12)}${seg(88,54,88,98,12)}
       ${seg(64,58,72,56,8)}${seg(96,58,88,56,8)}
       ${arrowV(40,80,116)}
       <g><animateTransform attributeName="transform" type="rotate" values="-75 64 100;0 64 100;-75 64 100" ${SP}/>${seg(64,100,64,124,8)}${joint(64,100)}</g>
       <g><animateTransform attributeName="transform" type="rotate" values="75 96 100;0 96 100;75 96 100" ${SP}/>${seg(96,100,96,124,8)}${joint(96,100)}</g>
       <g><animateTransform attributeName="transform" type="translate" values="0 -22;0 0;0 -22" ${SP}/>${barbell(80,124,24)}</g>`+close;

    /* ---- lunge / split squat (side, drop back knee) ---- */
    case 'lunge': return open+ground()+label('Drop straight down → drive up')+
      `<g><animateTransform attributeName="transform" type="translate" values="0 0;0 18;0 0" ${SP}/>
         ${head(74,42)}${seg(74,54,74,92,11)}
         ${seg(64,60,56,76,8)}${db(54,78)}${seg(84,60,92,76,8)}${db(94,78)}</g>
       ${seg(56,94,52,124,11)}${seg(52,124,44,150,11)}
       ${seg(92,94,98,122,11)}${seg(98,122,96,150,11)}${joint(74,92)}`+close;

    /* ---- calf raise (front, rise on toes) ---- */
    case 'calf': return open+ground()+label('Rise onto toes → lower heels')+
      `${arrowV(118,96,108)}
       <g><animateTransform attributeName="transform" type="translate" values="0 0;0 -14;0 0" dur="1.6s" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.5;1" keySplines="0.42 0 0.58 1;0.42 0 0.58 1"/>
         ${head(80,40)}${seg(72,52,72,92,11)}${seg(88,52,88,92,11)}
         ${seg(62,58,72,54,8)}${seg(98,58,88,54,8)}${db(60,58)}${db(100,58)}
         ${seg(72,92,70,150,11)}${seg(88,92,90,150,11)}</g>`+close;

    /* ---- lying leg curl (side, curl heel to glute) ---- */
    case 'legcurl': return open+
      `<rect x="24" y="110" width="100" height="9" rx="4" fill="var(--line)"/>${label('Curl heel up → lower')}
       ${head(38,100)}${seg(48,104,96,104,15,skin)}${joint(96,104)}
       ${arrowV(132,76,104)}
       <g><animateTransform attributeName="transform" type="rotate" values="0 96 104;-100 96 104;0 96 104" ${SP}/>
         ${seg(96,104,124,104,9)}${db(126,104)}</g>`+close;

    /* ---- core: plank / crunch / leg raise ---- */
    case 'core': return open+ground(150)+label('Brace core → controlled reps')+
      `${seg(50,140,104,140,13,skin)}
       <g><animateTransform attributeName="transform" type="rotate" values="0 104 140;-34 104 140;0 104 140" ${SP}/>
         ${seg(104,140,118,118,12)}${head(122,108)}</g>
       <g><animateTransform attributeName="transform" type="rotate" values="0 50 140;30 50 140;0 50 140" ${SP}/>
         ${seg(50,140,34,122,10)}</g>${joint(104,140)}${joint(50,140)}`+close;

    /* ---- generic fallback ---- */
    default: return open+ground()+label('Controlled reps · full range')+
      `${head(80,42)}${seg(72,54,72,98,12)}${seg(88,54,88,98,12)}
       ${seg(72,98,68,150,11)}${seg(88,98,92,150,11)}
       <g><animateTransform attributeName="transform" type="rotate" values="0 72 60;-34 72 60;0 72 60" ${SP}/>${seg(72,60,52,72,8)}${db(50,74)}${joint(72,60)}</g>
       <g><animateTransform attributeName="transform" type="rotate" values="0 88 60;34 88 60;0 88 60" ${SP}/>${seg(88,60,108,72,8)}${db(110,74)}${joint(88,60)}</g>`+close;
  }
}

/* ---------- ACTIVE SESSION ---------- */
function startSession(idx){
  const d=S.program.split[idx];
  S.active={name:d.name,idx,date:todayStr(),started:Date.now(),
    exercises:d.exercises.map(e=>(e.warmup||e.cardio)
      ? {name:e.name,muscle:e.muscle,cue:e.cue,warmup:e.warmup,cardio:e.cardio,items:e.items,done:false}
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
    if(e.warmup||e.cardio){
      const icon=e.cardio?'🏃':'🔥';const tag=e.cardio?'Cardio finisher':'Prime the joints — ~8 min';
      h+=`<div class="ex-card" style="border-color:var(--acc2)">
        <div class="ex-head"><div><div class="nm">${icon} ${e.name}</div><div class="meta">${tag}</div></div>
        <button class="set-done ${e.done?'on':''}" onclick="toggleWarmup(${ei})"><svg viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7"/></svg></button></div>
        <div style="padding:4px 16px 14px">${(e.items||[]).map(it=>`<div style="display:flex;gap:8px;padding:5px 0;font-size:13px;color:var(--txt2)"><span style="color:var(--acc)">•</span>${it}</div>`).join('')}</div>
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

  if(logged.length){
    const verdict=dayFoodVerdict(logged);
    h+=`<div class="card"><div class="card-h"><div class="t">Logged today</div></div>`;
    if(verdict)h+=`<div style="background:var(--bg3);border-left:3px solid ${verdict.c};border-radius:8px;padding:10px 12px;margin-bottom:12px;font-size:13px;color:var(--txt)">${verdict.t}</div>`;
    logged.forEach((f,i)=>{const q=foodQuality(f);
      h+=`<div class="food-log-item"><div style="display:flex;gap:8px;align-items:center"><span title="${q.label}" style="font-size:12px">${q.dot}</span><div><div class="fn">${f.name}</div><div class="fm" style="color:${q.color}">${q.label} · ${f.protein||0}p · ${f.carbs||0}c · ${f.fat||0}f</div></div></div><div class="fc">${f.cals}</div><button onclick="delFood(${i})" style="color:var(--txt3);font-size:18px;padding:0 4px">×</button></div>`;});
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
// Grade a food good / ok / poor from its macros + name keywords.
function foodQuality(f){
  const n=(f.name||'').toLowerCase();
  const cals=+f.cals||0, p=+f.protein||0, c=+f.carbs||0, fat=+f.fat||0, sugar=+f.sugar||0;
  let score=0;
  // protein density is good
  const pPerCal = cals?(p*4)/cals:0;
  if(pPerCal>0.3)score+=2; else if(pPerCal>0.18)score+=1;
  // keyword signals
  const junk=/candy|soda|cola|chips|cookie|donut|doughnut|cake|ice cream|fries|fried|chocolate bar|gummy|skittles|sour|pop.?tart|cereal bar|energy drink|slushie|milkshake/;
  const whole=/chicken|turkey|salmon|tuna|fish|egg|beef|steak|rice|oat|quinoa|broccoli|spinach|vegetable|veggie|salad|beans|lentil|yogurt|greek|fruit|apple|banana|berry|nuts|almond|potato|sweet potato/;
  if(junk.test(n))score-=2;
  if(whole.test(n))score+=2;
  // sugar (if available) and calorie density
  if(sugar>20)score-=1;
  if(cals>400 && p<10 && fat>20)score-=1; // calorie-dense, low protein, high fat
  if(score>=2)return {label:'Solid choice',color:'var(--green)',dot:'🟢'};
  if(score<=-1)return {label:'Treat — keep it occasional',color:'var(--red)',dot:'🔴'};
  return {label:'Fine in moderation',color:'var(--amber)',dot:'🟡'};
}
// One-line read on the whole day's eating.
function dayFoodVerdict(logged){
  if(!logged.length)return '';
  const grades=logged.map(foodQuality);
  const good=grades.filter(g=>g.color==='var(--green)').length;
  const bad=grades.filter(g=>g.color==='var(--red)').length;
  const totalP=logged.reduce((t,f)=>t+ +(f.protein||0),0);
  if(bad>=2 && bad>=good)return {t:`You've logged ${bad} treat-type foods today. One's fine — try swapping the rest for something with protein.`,c:'var(--amber)'};
  if(good>=2 && bad===0)return {t:`Clean day so far — mostly whole foods${totalP>80?' and protein is on point':''}. Keep it up.`,c:'var(--green)'};
  if(good===0 && logged.length>=2)return {t:`Not much whole food yet today. Aim to build meals around a protein + a veg or fruit.`,c:'var(--amber)'};
  return {t:`Balanced mix today. ${totalP<60?'Could use more protein.':'Protein looking good.'}`,c:'var(--txt2)'};
}
function openFoodForm(pre){
  pre=pre||{}; scanBusy=false;
  const esc=s=>(s||'').replace(/"/g,'&quot;');
  let banner='';
  if(pre.notFound) banner='<p class="small" style="color:var(--amber);margin-bottom:12px">Not found in the database — enter it manually.</p>';
  else if(pre.offline) banner='<p class="small" style="color:var(--red);margin-bottom:12px">Couldn\'t reach the food database. Check your connection or enter manually.</p>';
  else if(pre.per){
    const q=foodQuality(pre);
    banner=`<p class="small" style="color:var(--acc);margin-bottom:6px">✓ Found! Values ${pre.per}. Adjust to your portion.</p>
      <div style="background:var(--bg3);border-left:3px solid ${q.color};border-radius:8px;padding:9px 11px;margin-bottom:12px;font-size:13px">${q.dot} <b style="color:${q.color}">${q.label}</b></div>`;
  }
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
      d.onclick=()=>modal(`<h3>${new Date(p.date).toLocaleDateString('default',{month:'long',day:'numeric',year:'numeric'})}</h3><img src="${p.data}" style="border-radius:14px;width:100%;margin-bottom:14px">${S.settings.geminiKey?`<button class="btn" onclick="photoFeedback('${p.id}')">⚡ Get AI build feedback</button>`:`<p class="small" style="text-align:center;color:var(--txt2);margin-bottom:12px">Add a Gemini key in Settings to get AI feedback on your physique.</p>`}<button class="btn ghost" style="background:var(--redbg);color:var(--red);margin-top:10px" onclick="delPhoto(${p.id})">Delete photo</button><button class="btn ghost" style="margin-top:10px" onclick="closeModal()">Close</button>`);
      g.appendChild(d);});};
}
async function delPhoto(id){await openPhotoDB();const tx=photoDB.transaction('p','readwrite');tx.objectStore('p').delete(id);tx.oncomplete=()=>{closeModal();loadPhotos();};}
async function photoFeedback(id){
  await openPhotoDB();const tx=photoDB.transaction('p','readonly');
  const req=tx.objectStore('p').get(+id);
  req.onsuccess=async()=>{
    const p=req.result;if(!p)return;
    const b64=(p.data||'').split(',')[1];
    modal(`<h3>⚡ Build Feedback</h3><p style="color:var(--txt2)">Coach is looking at your photo…</p>`);
    const pri=(S.profile.priority||[]).map(m=>MUSCLE_LABELS[m]).join(', ')||'balanced development';
    const prompt=`You are this person's strength coach looking at their physique progress photo. They are ${S.profile.age}, ${S.profile.weight}lb, goal=${S.profile.goal}, and want to grow: ${pri}. Talk like a real coach — warm, direct, encouraging but honest. In 3-5 sentences: what looks like it's developing well, what's lagging and should get priority, and one concrete training or nutrition tip. No bullet points, no AI disclaimers, just talk to them like a person.`;
    try{const fb=await geminiCall(prompt,b64);
      modal(`<h3>⚡ Build Feedback</h3><div style="background:var(--bg3);border-radius:12px;padding:14px;line-height:1.6;color:var(--txt)">${(fb||'Looking solid — keep training consistently.').replace(/\n/g,'<br>')}</div><button class="btn ghost" style="margin-top:16px" onclick="closeModal()">Got it</button>`);
    }catch(e){modal(`<h3>⚡ Build Feedback</h3><p style="color:var(--red)">${aiErrorMsg(e)}</p><button class="btn ghost" style="margin-top:14px" onclick="closeModal()">Close</button>`);}
  };
}

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
    <div class="field"><label>Equipment & program</label>
      <button class="btn ghost" onclick="editEquipment()">Edit my equipment</button>
      <button class="btn ghost" style="margin-top:8px" onclick="rebuildProgramPrompt()">Rebuild my program</button>
      <p class="small" style="margin-top:8px">Rebuild after changing equipment or goal — it re-picks every exercise for the gear you actually have (e.g. no bench → push-ups instead of barbell bench).</p></div>
    <button class="btn" onclick="saveSettings()">Save</button>
    <button class="btn ghost" style="margin-top:10px" onclick="exportData()">Export my data</button>
    <button class="btn ghost" style="margin-top:10px;color:var(--red)" onclick="resetApp()">Reset everything</button>
    <p class="small" style="text-align:center;margin-top:16px">FORGE · all data stored locally on your device</p>`);
}
// Edit equipment after onboarding, then offer a rebuild.
function editEquipment(){
  const selected=new Set(S.profile.equipment||[]);
  let h=`<h3>Your equipment</h3><p style="color:var(--txt2);margin-bottom:12px">Tap to toggle. If you don't have a bench, leave it off and I'll never program flat barbell pressing.</p><div style="max-height:50vh;overflow-y:auto">`;
  EQUIP_CATS.forEach(cat=>{
    h+=`<div class="eq-cat"><div class="ct">${cat.cat}</div><div class="chips">`;
    cat.items.forEach(it=>{h+=`<button class="chip multi${selected.has(it.id)?' on':''}" data-eqedit="${it.id}" onclick="this.classList.toggle('on')">${it.n}</button>`;});
    h+=`</div></div>`;
  });
  h+=`</div><button class="btn" style="margin-top:14px" onclick="saveEquipmentEdit()">Save equipment</button>
    <button class="btn ghost" style="margin-top:10px" onclick="openSettings()">Back</button>`;
  modal(h);
}
function saveEquipmentEdit(){
  S.profile.equipment=$$('[data-eqedit].on').map(b=>b.dataset.eqedit);
  save();closeModal();
  modal(`<h3>Equipment saved</h3><p style="color:var(--txt2);line-height:1.5">Want me to rebuild your program around your updated gear now? Your logged workouts and stats stay.</p>
    <button class="btn" style="margin-top:14px" onclick="doRebuild()">Rebuild program</button>
    <button class="btn ghost" style="margin-top:10px" onclick="closeModal()">Not now</button>`);
}
function rebuildProgramPrompt(){
  modal(`<h3>Rebuild program?</h3><p style="color:var(--txt2);line-height:1.5">I'll re-pick every exercise for your current equipment, goal, and strength. Your history, PRs, and food log are untouched — only the upcoming workouts change.</p>
    <button class="btn" style="margin-top:14px" onclick="doRebuild()">Rebuild now</button>
    <button class="btn ghost" style="margin-top:10px" onclick="closeModal()">Cancel</button>`);
}
function doRebuild(){
  S.program=buildLocalProgram();
  S.nutrition.plan=buildLocalMeals();
  save();closeModal();
  toast('Program rebuilt for your gear','good');
  go('workout');
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
