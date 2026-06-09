
// ── Register Service Worker (PWA install support) ─────────────────────────
if('serviceWorker' in navigator){
  window.addEventListener('load',function(){
    navigator.serviceWorker.register('sw.js')
      .then(function(){ console.log('DEWA PWA ready'); })
      .catch(function(e){ console.warn('SW:', e.message); });
  });
}

/* patch.js — DEWA GIS Team File Patch
   Hosted on GitHub alongside team.html.
   Every generated team.html loads this automatically.
   Update this file once — all team files get the fix instantly. */

// ── normDate: handles any date format including Apps Script long format ──
function normDate(s){
  if(!s)return'';
  s=String(s).trim();
  var mL=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  if(/^\d{1,2} [A-Za-z]{3} \d{4}$/.test(s))return s;
  var a=s.match(/^(\d{1,2})[.\/'"](\d{1,2})[.\/'"](\d{4})/);
  if(a)return parseInt(a[1],10)+' '+mL[parseInt(a[2],10)-1]+' '+a[3];
  var b=s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if(b)return parseInt(b[3],10)+' '+mL[parseInt(b[2],10)-1]+' '+b[1];
  try{var d=new Date(s);if(!isNaN(d.getTime()))return d.getDate()+' '+mL[d.getMonth()]+' '+d.getFullYear();}catch(e){}
  return s;
}

// ── syncFromSheet: fetches live statuses from Apps Script ────────────────
var _sT=null;
function syncFromSheet(){
  if(typeof _wbUrl==='undefined'||!_wbUrl)return;
  var el=document.getElementById('syncStatus');
  if(el){el.textContent='...';el.style.color='#94a3b8';}
  fetch(_wbUrl+'?action=getAll&_t='+Date.now())
    .then(function(r){return r.json();})
    .then(function(d){
      if(!d.ok||!d.data)return;
      Object.keys(d.data).forEach(function(k){
        var e=d.data[k];
        var n=(typeof norm==='function')?norm(k):k.trim();
        if(!jobData[n])jobData[n]={};
        if(e.status)jobData[n].status=e.status;
        if(e.team)jobData[n].team=e.team;
        if(e.completedDate)jobData[n].completedDate=e.completedDate;
        if(e.actualArea)jobData[n].actualArea=e.actualArea;
        if((e.status||'').toLowerCase()==='completed')jobData[n].locked=true;
      });
      if(typeof persistJobData==='function')persistJobData();
      if(typeof doCluster==='function')doCluster();
      if(el){el.textContent='\u2714';el.style.color='#22c55e';
        setTimeout(function(){if(el)el.textContent='';},3000);}
    })
    .catch(function(e){
      console.warn('Sync error:',e.message);
      if(el){el.textContent='err';el.style.color='#ef4444';}
    });
}

// ── showTodaySummary: adds AREA m2 column ────────────────────────────────
function showTodaySummary(){
  if(typeof getTodayStr==='undefined')return;
  var _td=getTodayStr();
  var all=[];
  if(typeof clusters!=='undefined')all=[].concat.apply([],clusters);
  if(typeof lone!=='undefined')all=all.concat(lone);
  var done=all.filter(function(j){
    return normDate(jd(j.notifNo).completedDate)===normDate(_td);
  });
  if(!done.length){alert('No jobs completed today ('+_td+').');return;}
  var tc={Mubarak:'#3b82f6',Yousaf:'#f59e0b',Azeem:'#a855f7',Mudasir:'#ec4899',Shahbaz:'#f97316'};
  var gr={Mubarak:0,Yousaf:0,Azeem:0,Mudasir:0,Shahbaz:0,Other:0};
  var ga={Mubarak:0,Yousaf:0,Azeem:0,Mudasir:0,Shahbaz:0,Other:0};
  done.forEach(function(j){
    var d=jd(j.notifNo);
    var t=(d.team||'').trim()||'Other';
    var a=parseFloat(d.actualArea)||0;
    if(gr.hasOwnProperty(t)){gr[t]++;ga[t]+=a;}else{gr.Other++;ga.Other+=a;}
  });
  var totalArea=0;
  var wa=['DEWA Daily Summary','Date: '+_td,'Total: '+done.length+' jobs',''];
  var ex=document.getElementById('tSumM');if(ex)ex.remove();
  var ov=document.createElement('div');ov.id='tSumM';
  ov.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px';
  var inn=document.createElement('div');
  inn.style.cssText='background:#111827;border:1px solid #1e2d45;border-radius:14px;width:100%;max-width:440px;max-height:85vh;display:flex;flex-direction:column';
  var hd=document.createElement('div');
  hd.style.cssText='padding:14px;border-bottom:1px solid #1e2d45;display:flex;justify-content:space-between;align-items:center';
  var ht=document.createElement('b');ht.textContent='Today Summary';ht.style.color='#e2e8f0';
  var cb=document.createElement('button');cb.textContent='x';
  cb.style.cssText='background:none;border:none;color:#94a3b8;font-size:20px;cursor:pointer';
  cb.onclick=function(){ov.remove();};
  hd.appendChild(ht);hd.appendChild(cb);
  var bd=document.createElement('div');bd.style.cssText='padding:14px;overflow-y:auto;flex:1';
  var hero=document.createElement('div');
  hero.style.cssText='text-align:center;padding:14px;margin-bottom:14px;background:rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.2);border-radius:10px';
  var dt=document.createElement('div');dt.textContent=_td;dt.style.cssText='font-size:11px;color:#94a3b8';
  var big=document.createElement('div');big.textContent=done.length;big.style.cssText='font-size:44px;font-weight:800;color:#22c55e';
  var sub=document.createElement('div');sub.style.cssText='font-size:12px;color:#94a3b8';
  hero.appendChild(dt);hero.appendChild(big);hero.appendChild(sub);bd.appendChild(hero);
  var tbl=document.createElement('table');tbl.style.cssText='width:100%;border-collapse:collapse';
  var hrow=document.createElement('tr');
  ['TEAM','JOBS','AREA m2'].forEach(function(h,i){
    var th=document.createElement('th');th.textContent=h;
    th.style.cssText='padding:8px 14px;color:#94a3b8;font-size:11px;border-bottom:2px solid #1e2d45;text-align:'+(i===0?'left':'center');
    hrow.appendChild(th);
  });
  tbl.appendChild(hrow);
  ['Mubarak','Yousaf','Azeem','Mudasir','Shahbaz','Other'].forEach(function(t){
    if(!gr[t])return;
    var col=tc[t]||'#94a3b8';var a=ga[t];totalArea+=a;
    wa.push(t+': '+gr[t]+' jobs, '+a.toFixed(1)+' m2');
    var tr=document.createElement('tr');
    var c1=document.createElement('td');c1.textContent=t;
    c1.style.cssText='padding:10px 14px;color:'+col+';font-weight:700;border-bottom:1px solid #1e2d45';
    var c2=document.createElement('td');c2.textContent=gr[t];
    c2.style.cssText='padding:10px 14px;text-align:center;font-size:22px;font-weight:800;color:'+col+';border-bottom:1px solid #1e2d45';
    var c3=document.createElement('td');c3.textContent=a.toFixed(1);
    c3.style.cssText='padding:10px 14px;text-align:center;font-weight:700;color:'+col+';border-bottom:1px solid #1e2d45';
    tr.appendChild(c1);tr.appendChild(c2);tr.appendChild(c3);tbl.appendChild(tr);
  });
  sub.textContent='Jobs Completed / '+totalArea.toFixed(1)+' m2 Area';
  wa.push('Total Area: '+totalArea.toFixed(1)+' m2');
  var fr=document.createElement('tr');fr.style.cssText='border-top:2px solid var(--acc)';
  var f1=document.createElement('td');f1.textContent='TOTAL';
  f1.style.cssText='padding:10px 14px;color:#e2e8f0;font-weight:700';
  var f2=document.createElement('td');f2.textContent=done.length;
  f2.style.cssText='padding:10px 14px;text-align:center;font-size:24px;font-weight:800;color:#22c55e';
  var f3=document.createElement('td');f3.textContent=totalArea.toFixed(1);
  f3.style.cssText='padding:10px 14px;text-align:center;font-size:18px;font-weight:800;color:#00c9a7';
  fr.appendChild(f1);fr.appendChild(f2);fr.appendChild(f3);tbl.appendChild(fr);bd.appendChild(tbl);
  var ft=document.createElement('div');ft.style.cssText='padding:12px;border-top:1px solid #1e2d45';
  var wb=document.createElement('button');wb.textContent='Copy for WhatsApp';
  wb.style.cssText='width:100%;padding:10px;background:rgba(37,211,102,.15);border:1px solid rgba(37,211,102,.3);color:#25d366;border-radius:8px;cursor:pointer;font-weight:700;font-size:13px';
  wb.onclick=function(){
    var ta=document.createElement('textarea');ta.value=wa.join('\n');
    ta.style.position='fixed';ta.style.top='-9999px';
    document.body.appendChild(ta);ta.select();document.execCommand('copy');
    document.body.removeChild(ta);
    this.textContent='Copied!';
    var b=this;setTimeout(function(){b.textContent='Copy for WhatsApp';},2000);
  };
  ft.appendChild(wb);inn.appendChild(hd);inn.appendChild(bd);inn.appendChild(ft);
  ov.appendChild(inn);document.body.appendChild(ov);
  ov.onclick=function(e){if(e.target===ov)ov.remove();};
}

// ── On DOM ready: add Refresh button + start auto-sync ───────────────────
document.addEventListener('DOMContentLoaded',function(){
  // Add Refresh button next to Maps Route button
  var btnGM=document.getElementById('btnGM');
  if(btnGM&&btnGM.parentNode){
    var btn=document.createElement('button');
    btn.className='ebtn';
    btn.onclick=syncFromSheet;
    btn.title='Refresh from Sheet';
    btn.style.cssText='background:rgba(0,201,167,.12);border-color:rgba(0,201,167,.4);color:#00c9a7';
    btn.innerHTML='&#128260; Refresh';
    var sp=document.createElement('span');
    sp.id='syncStatus';
    sp.style.cssText='font-size:10px;font-family:monospace;margin-left:4px;vertical-align:middle';
    btnGM.parentNode.insertBefore(btn,btnGM.nextSibling);
    btnGM.parentNode.insertBefore(sp,btn.nextSibling);
  }
  // Start sync: 800ms after load, then every 2 minutes
  setTimeout(function(){
    syncFromSheet();
    _sT=setInterval(syncFromSheet,120000);
  },800);
});

// ── Auto-load camera-patch.js ─────────────────────────────────────────────
(function(){
  var s=document.createElement('script');s.src='camera-patch.js';
  document.head.appendChild(s);
})();

// ── Auto-load progress-patch.js ───────────────────────────────────────────
(function(){
  var s=document.createElement('script');s.src='progress-patch.js';
  document.head.appendChild(s);
})();
