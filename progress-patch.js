/* progress-patch.js — DEWA In-Progress Photos
   Optional 1-5 photos per visit, uploads immediately to Drive.
   Persists via localStorage across modal opens.
   DO NOT modify — camera-patch.js handles completion photo separately. */

(function(){
  'use strict';

  var MAX_PER_VISIT = 5;
  var _session = 0;   // photos taken this visit (resets when modal closes)
  var _visitN  = null;

  // ── Helpers ───────────────────────────────────────────────────────────
  function lsKey(n){ return 'dewa_pp_' + String(n).trim(); }

  function getPhotos(n){
    try{ return JSON.parse(localStorage.getItem(lsKey(n))||'[]'); }catch(e){ return []; }
  }
  function setPhotos(n, arr){
    try{ localStorage.setItem(lsKey(n), JSON.stringify(arr)); }catch(e){}
  }
  function pushPhoto(n, obj){
    var a = getPhotos(n); a.push(obj); setPhotos(n, a); return a.length-1;
  }
  function updatePhoto(n, idx, patch){
    var a = getPhotos(n);
    if(a[idx]){ for(var k in patch) a[idx][k]=patch[k]; setPhotos(n, a); }
  }

  // ── Make small thumbnail from File ────────────────────────────────────
  function makeThumb(file, cb){
    var r=new FileReader();
    r.onload=function(ev){
      var img=new Image();
      img.onload=function(){
        var S=100, w=img.width, h=img.height;
        if(w>h){h=Math.round(h*S/w);w=S;}else{w=Math.round(w*S/h);h=S;}
        var cv=document.createElement('canvas'); cv.width=w; cv.height=h;
        cv.getContext('2d').drawImage(img,0,0,w,h);
        cb(cv.toDataURL('image/jpeg',0.55));
      };
      img.onerror=function(){ cb(''); };
      img.src=ev.target.result;
    };
    r.readAsDataURL(file);
  }

  // ── Compress for upload ───────────────────────────────────────────────
  function compress(file, cb){
    var r=new FileReader();
    r.onload=function(ev){
      var img=new Image();
      img.onload=function(){
        var MAX=1024, w=img.width, h=img.height;
        if(w>MAX){h=Math.round(h*MAX/w);w=MAX;}
        if(h>MAX){w=Math.round(w*MAX/h);h=MAX;}
        var cv=document.createElement('canvas'); cv.width=w; cv.height=h;
        cv.getContext('2d').drawImage(img,0,0,w,h);
        var d=cv.toDataURL('image/jpeg',0.75);
        cb(d.split(',')[1],'image/jpeg');
      };
      img.onerror=function(){cb(null,'Cannot read image');};
      img.src=ev.target.result;
    };
    r.onerror=function(){cb(null,'Cannot read file');};
    r.readAsDataURL(file);
  }

  // ── Upload one progress photo ─────────────────────────────────────────
  function uploadOne(notifNo, b64, mime, cb){
    if(typeof _wbUrl==='undefined'||!_wbUrl){ cb(null,'No Apps Script URL'); return; }
    var xhr=new XMLHttpRequest();
    xhr.open('POST',_wbUrl,true);
    xhr.setRequestHeader('Content-Type','text/plain');
    xhr.timeout=35000;
    xhr.onload=function(){
      try{
        var d=JSON.parse(xhr.responseText);
        d.ok ? cb(d,null) : cb(null,d.msg||'Upload failed');
      }catch(e){ cb(null,'Parse error: '+xhr.responseText.slice(0,80)); }
    };
    xhr.onerror=function(){ cb(null,'Network error'); };
    xhr.ontimeout=function(){ cb(null,'Timed out (35s)'); };
    xhr.send(JSON.stringify({
      action:'saveProgressPhoto',
      notifNo:notifNo,
      photoData:b64,
      mimeType:mime
    }));
  }

  // ── Build one thumbnail card ───────────────────────────────────────────
  function thumbCard(n, idx, p){
    var wrap=document.createElement('div');
    wrap.setAttribute('data-pp',idx);
    var borderCol = p.status==='done'?'#22c55e' : p.status==='failed'?'#ef4444':'#f59e0b';
    wrap.style.cssText='position:relative;width:68px;height:68px;border-radius:8px;'
      +'overflow:hidden;border:2px solid '+borderCol+';flex-shrink:0';

    var img=document.createElement('img');
    img.src=p.thumb||'';
    img.style.cssText='width:100%;height:100%;object-fit:cover;display:block';
    wrap.appendChild(img);

    var badge=document.createElement('div');
    var bStyle='position:absolute;bottom:0;left:0;right:0;text-align:center;'
      +'font-size:9px;font-weight:700;padding:2px 0;';
    if(p.status==='done'){
      badge.style.cssText=bStyle+'background:rgba(34,197,94,.9);color:#fff';
      badge.textContent='✓';
    } else if(p.status==='failed'){
      badge.style.cssText=bStyle+'background:rgba(239,68,68,.9);color:#fff;cursor:pointer';
      badge.textContent='✕ Remove';
      badge.onclick=function(){
        if(!confirm('Remove this failed photo?')) return;
        var arr=getPhotos(n); arr.splice(idx,1); setPhotos(n,arr);
        _session=Math.max(0,_session-1);
        refreshGrid(n);
      };
    } else {
      badge.style.cssText=bStyle+'background:rgba(245,158,11,.9);color:#fff';
      badge.textContent='⏳';
    }
    wrap.appendChild(badge);
    return wrap;
  }

  // ── Refresh grid ──────────────────────────────────────────────────────
  function refreshGrid(n){
    var g=document.getElementById('ppGrid'); if(!g) return;
    g.innerHTML='';
    getPhotos(n).forEach(function(p,i){ g.appendChild(thumbCard(n,i,p)); });
    updateCountBadge(n);
    updateAddBtn();
  }

  function updateCountBadge(n){
    var el=document.getElementById('ppCountBadge'); if(!el) return;
    var c=getPhotos(n).filter(function(p){return p.status==='done';}).length;
    el.textContent = c ? c+' uploaded' : '';
  }

  function updateAddBtn(){
    var btn=document.getElementById('ppAddLbl');
    var inp=document.getElementById('ppInp');
    if(!btn) return;
    var disabled=(_session>=MAX_PER_VISIT);
    btn.style.opacity=disabled?'0.4':'1';
    btn.style.pointerEvents=disabled?'none':'';
    if(inp) inp.disabled=disabled;
    btn.textContent=disabled?'Max '+MAX_PER_VISIT+' per visit':'+ Add Photo';
  }

  // ── Build progress section ────────────────────────────────────────────
  function buildSection(n){
    var sec=document.createElement('div');
    sec.id='ppSection';
    sec.style.cssText='padding:11px 12px;background:rgba(0,201,167,.05);'
      +'border:1px solid rgba(0,201,167,.2);border-radius:10px;margin:8px 0 4px';

    // Header row
    var hdr=document.createElement('div');
    hdr.style.cssText='display:flex;justify-content:space-between;align-items:center;margin-bottom:8px';
    var htitle=document.createElement('div');
    htitle.style.cssText='font-size:12px;font-weight:700;color:#00c9a7';
    htitle.innerHTML='📸 In-Progress Photos '
      +'<span style="font-weight:400;color:#64748b;font-size:10px">optional · max '+MAX_PER_VISIT+'/visit</span>';
    var badge=document.createElement('span');
    badge.id='ppCountBadge';
    badge.style.cssText='font-size:10px;color:#94a3b8;font-family:monospace';
    hdr.appendChild(htitle); hdr.appendChild(badge);

    // Thumbnail grid
    var grid=document.createElement('div');
    grid.id='ppGrid';
    grid.style.cssText='display:flex;flex-wrap:wrap;gap:7px;margin-bottom:9px;min-height:4px';

    // Load existing photos
    getPhotos(n).forEach(function(p,i){ grid.appendChild(thumbCard(n,i,p)); });
    updateCountBadge(n);

    // Add button (label + hidden input = most reliable on mobile)
    var inp=document.createElement('input');
    inp.type='file'; inp.id='ppInp'; inp.accept='image/*';
    inp.style.cssText='position:fixed;top:-300px;left:-300px;width:1px;height:1px;opacity:0;pointer-events:none';

    var lbl=document.createElement('label');
    lbl.id='ppAddLbl'; lbl.htmlFor='ppInp';
    lbl.style.cssText='display:inline-block;padding:8px 14px;'
      +'background:rgba(0,201,167,.12);border:1px solid rgba(0,201,167,.35);'
      +'color:#00c9a7;border-radius:7px;cursor:pointer;font-size:12px;font-weight:600';
    lbl.textContent='+ Add Photo';

    var statusBar=document.createElement('div');
    statusBar.id='ppStatus';
    statusBar.style.cssText='margin-top:7px;font-size:11px;padding:6px 8px;border-radius:6px;display:none';

    function showStatus(msg,col,bg){
      statusBar.textContent=msg; statusBar.style.color=col;
      statusBar.style.background=bg; statusBar.style.display='block';
    }
    function hideStatus(){ statusBar.style.display='none'; }

    // File selected handler
    inp.addEventListener('change',function(){
      var file=inp.files&&inp.files[0]; if(!file) return;
      if(_session>=MAX_PER_VISIT) return;
      inp.value='';

      showStatus('⏳ Preparing photo...','#f59e0b','rgba(245,158,11,.08)');

      makeThumb(file,function(thumb){
        compress(file,function(b64,mime){
          if(!b64){ showStatus('❌ Cannot read image','#ef4444','rgba(239,68,68,.08)'); return; }

          var nn = n || (typeof curN!=='undefined'?curN:'');
          var idx=pushPhoto(nn,{status:'uploading',thumb:thumb,ts:Date.now()});
          _session++;
          refreshGrid(nn);
          updateAddBtn();
          showStatus('⏳ Uploading ('+ _session +'/'+MAX_PER_VISIT+')...','#f59e0b','rgba(245,158,11,.08)');

          uploadOne(nn,b64,mime,function(resp,err){
            if(err){
              updatePhoto(nn,idx,{status:'failed'});
              refreshGrid(nn);
              showStatus('❌ Upload failed: '+err+'. Tap ✕ to remove & retake.','#ef4444','rgba(239,68,68,.08)');
              return;
            }
            updatePhoto(nn,idx,{status:'done',url:resp.url||'',name:resp.name||''});
            refreshGrid(nn);
            showStatus('✔ Photo saved to Drive!','#22c55e','rgba(34,197,94,.08)');
            setTimeout(hideStatus,3000);
          });
        });
      });
    });

    updateAddBtn();
    sec.appendChild(hdr);
    sec.appendChild(grid);
    sec.appendChild(inp);
    sec.appendChild(lbl);
    sec.appendChild(statusBar);
    return sec;
  }

  // ── Inject section into open modal ────────────────────────────────────
  function inject(n){
    if(document.getElementById('ppSection')) return;
    // Insert before the .ma buttons area
    var ma=document.querySelector('.ma');
    if(!ma) return;
    var sec=buildSection(n);
    ma.parentNode.insertBefore(sec,ma);
  }

  // ── Remove section & reset ────────────────────────────────────────────
  function remove(){
    var s=document.getElementById('ppSection');
    if(s&&s.parentNode) s.parentNode.removeChild(s);
    _session=0;
  }

  // ── Watch curN (same pattern as camera-patch) ─────────────────────────
  var _last=null;
  setInterval(function(){
    try{
      var n=(typeof curN!=='undefined')?curN:null;
      if(n!==_last){
        _last=n;
        remove();
        if(n){ _visitN=n; setTimeout(function(){ inject(n); },180); }
      }
    }catch(e){}
  },300);

})();
