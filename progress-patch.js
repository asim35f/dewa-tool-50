/* progress-patch.js — DEWA In-Progress Photos v2
   - MutationObserver detects modal open/close (fixes same-job reopen bug)
   - Each modal open = fresh session (5 photos per open, unlimited total)
   - Photos persist in localStorage across app closes/reopens
   - Delete button on each thumbnail removes from UI + localStorage
   - Upload immediately on photo selection */

(function(){
  'use strict';

  var MAX_PER_VISIT = 5;
  var _session = 0;

  // ── localStorage helpers ──────────────────────────────────────────────
  function lsKey(n){ return 'dewa_pp_' + String(n).trim(); }

  function getPhotos(n){
    try{ return JSON.parse(localStorage.getItem(lsKey(n)) || '[]'); }
    catch(e){ return []; }
  }
  function setPhotos(n, arr){
    try{ localStorage.setItem(lsKey(n), JSON.stringify(arr)); }catch(e){}
  }
  function pushPhoto(n, obj){
    var a = getPhotos(n); a.push(obj); setPhotos(n, a); return a.length - 1;
  }
  function updatePhoto(n, idx, patch){
    var a = getPhotos(n);
    if(a[idx]){ Object.keys(patch).forEach(function(k){ a[idx][k]=patch[k]; }); setPhotos(n, a); }
  }
  function deletePhoto(n, idx){
    var a = getPhotos(n); a.splice(idx, 1); setPhotos(n, a);
  }

  // ── Compress to small thumbnail (for localStorage preview) ────────────
  function makeThumb(file, cb){
    var r = new FileReader();
    r.onload = function(ev){
      var img = new Image();
      img.onload = function(){
        var S=100, w=img.width, h=img.height;
        if(w>h){ h=Math.round(h*S/w); w=S; } else { w=Math.round(w*S/h); h=S; }
        var cv=document.createElement('canvas'); cv.width=w; cv.height=h;
        cv.getContext('2d').drawImage(img,0,0,w,h);
        cb(cv.toDataURL('image/jpeg',0.55));
      };
      img.onerror=function(){ cb(''); };
      img.src=ev.target.result;
    };
    r.readAsDataURL(file);
  }

  // ── Compress full size for upload ─────────────────────────────────────
  function compress(file, cb){
    var r = new FileReader();
    r.onload = function(ev){
      var img = new Image();
      img.onload = function(){
        var MAX=1024, w=img.width, h=img.height;
        if(w>MAX){ h=Math.round(h*MAX/w); w=MAX; }
        if(h>MAX){ w=Math.round(w*MAX/h); h=MAX; }
        var cv=document.createElement('canvas'); cv.width=w; cv.height=h;
        cv.getContext('2d').drawImage(img,0,0,w,h);
        var d=cv.toDataURL('image/jpeg',0.75);
        cb(d.split(',')[1],'image/jpeg');
      };
      img.onerror=function(){ cb(null,'Cannot read image'); };
      img.src=ev.target.result;
    };
    r.onerror=function(){ cb(null,'Cannot read file'); };
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
      }catch(e){ cb(null,'Parse error'); }
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

  // ── Build one thumbnail card ──────────────────────────────────────────
  function thumbCard(n, idx, p, onDelete){
    var wrap=document.createElement('div');
    wrap.style.cssText='position:relative;width:72px;height:72px;border-radius:8px;'
      +'overflow:visible;flex-shrink:0';

    // Image container
    var imgWrap=document.createElement('div');
    imgWrap.style.cssText='width:72px;height:72px;border-radius:8px;overflow:hidden;'
      +'border:2px solid '+(p.status==='done'?'#22c55e':p.status==='failed'?'#ef4444':'#f59e0b');

    var img=document.createElement('img');
    img.src=p.thumb||'';
    img.style.cssText='width:100%;height:100%;object-fit:cover;display:block';
    imgWrap.appendChild(img);

    // Status badge
    var badge=document.createElement('div');
    badge.style.cssText='position:absolute;bottom:0;left:0;right:0;text-align:center;'
      +'font-size:9px;font-weight:700;padding:2px 0;border-radius:0 0 6px 6px;';
    if(p.status==='done'){
      badge.style.cssText+=('background:rgba(34,197,94,.9);color:#fff');
      badge.textContent='✓ Saved';
    } else if(p.status==='failed'){
      badge.style.cssText+=('background:rgba(239,68,68,.9);color:#fff');
      badge.textContent='⚠ Failed';
    } else {
      badge.style.cssText+=('background:rgba(245,158,11,.9);color:#fff');
      badge.textContent='⏳';
    }
    imgWrap.appendChild(badge);

    // ── Delete button (top-right corner) ────────────────────────────────
    var del=document.createElement('button');
    del.title='Delete this photo';
    del.style.cssText='position:absolute;top:-7px;right:-7px;width:20px;height:20px;'
      +'border-radius:50%;background:#ef4444;border:2px solid #0a0e1a;'
      +'color:#fff;font-size:11px;font-weight:700;cursor:pointer;'
      +'display:flex;align-items:center;justify-content:center;'
      +'line-height:1;padding:0;z-index:10;';
    del.textContent='×';
    del.disabled = (p.status==='uploading');
    del.style.opacity = (p.status==='uploading') ? '0.4' : '1';
    del.onclick=function(e){
      e.stopPropagation();
      if(p.status==='uploading') return;
      if(!confirm('Remove this photo from the list?\n(File in Google Drive will NOT be deleted)')) return;
      deletePhoto(n, idx);
      refreshGrid(n);
    };

    wrap.appendChild(imgWrap);
    wrap.appendChild(del);
    return wrap;
  }

  // ── Refresh the thumbnail grid ────────────────────────────────────────
  function refreshGrid(n){
    var grid=document.getElementById('ppGrid'); if(!grid) return;
    grid.innerHTML='';
    getPhotos(n).forEach(function(p,i){ grid.appendChild(thumbCard(n,i,p)); });
    updateCountBadge(n);
    updateAddBtn();
  }

  function updateCountBadge(n){
    var el=document.getElementById('ppCountBadge'); if(!el) return;
    var photos=getPhotos(n);
    var done=photos.filter(function(p){ return p.status==='done'; }).length;
    var total=photos.length;
    el.textContent = total ? (done+'/'+total+' uploaded') : '';
  }

  function updateAddBtn(){
    var btn=document.getElementById('ppAddLbl');
    var inp=document.getElementById('ppInp');
    if(!btn) return;
    var disabled=(_session>=MAX_PER_VISIT);
    btn.style.opacity=disabled?'0.4':'1';
    btn.style.pointerEvents=disabled?'none':'';
    if(inp) inp.disabled=disabled;
    btn.innerHTML=disabled
      ?'<span style="font-size:11px">Max '+MAX_PER_VISIT+'/visit reached</span>'
      :'+ Add Photo ('+(MAX_PER_VISIT-_session)+' left)';
  }

  // ── Build progress section ────────────────────────────────────────────
  function buildSection(n){
    var sec=document.createElement('div');
    sec.id='ppSection';
    sec.style.cssText='padding:11px 12px;background:rgba(0,201,167,.05);'
      +'border:1px solid rgba(0,201,167,.2);border-radius:10px;margin:8px 0 4px';

    // Header
    var hdr=document.createElement('div');
    hdr.style.cssText='display:flex;justify-content:space-between;align-items:center;margin-bottom:8px';
    var htitle=document.createElement('div');
    htitle.style.cssText='font-size:12px;font-weight:700;color:#00c9a7';
    htitle.innerHTML='📸 In-Progress Photos '
      +'<span style="font-weight:400;color:#64748b;font-size:10px">optional · max '
      +MAX_PER_VISIT+' per session</span>';
    var badge=document.createElement('span');
    badge.id='ppCountBadge';
    badge.style.cssText='font-size:10px;color:#94a3b8;font-family:monospace';
    hdr.appendChild(htitle); hdr.appendChild(badge);

    // Grid
    var grid=document.createElement('div');
    grid.id='ppGrid';
    grid.style.cssText='display:flex;flex-wrap:wrap;gap:10px;margin-bottom:9px;min-height:4px;padding:2px';

    // Load existing photos from localStorage
    getPhotos(n).forEach(function(p,i){ grid.appendChild(thumbCard(n,i,p)); });
    updateCountBadge(n);

    // Hidden file input + label button
    var inp=document.createElement('input');
    inp.type='file'; inp.id='ppInp'; inp.accept='image/*';
    inp.style.cssText='position:fixed;top:-300px;left:-300px;width:1px;height:1px;opacity:0;pointer-events:none';

    var lbl=document.createElement('label');
    lbl.id='ppAddLbl'; lbl.htmlFor='ppInp';
    lbl.style.cssText='display:inline-block;padding:8px 14px;'
      +'background:rgba(0,201,167,.12);border:1px solid rgba(0,201,167,.35);'
      +'color:#00c9a7;border-radius:7px;cursor:pointer;font-size:12px;font-weight:600';
    lbl.textContent='+ Add Photo ('+MAX_PER_VISIT+' left)';

    var statusBar=document.createElement('div');
    statusBar.id='ppStatus';
    statusBar.style.cssText='margin-top:7px;font-size:11px;padding:6px 8px;border-radius:6px;display:none';

    function showStatus(msg,col,bg){
      statusBar.textContent=msg;
      statusBar.style.color=col;
      statusBar.style.background=bg;
      statusBar.style.display='block';
    }
    function hideStatus(){ statusBar.style.display='none'; }

    // File selected → compress → upload immediately
    inp.addEventListener('change',function(){
      var file=inp.files&&inp.files[0]; if(!file) return;
      if(_session>=MAX_PER_VISIT) return;
      inp.value='';

      showStatus('⏳ Preparing...','#f59e0b','rgba(245,158,11,.08)');

      makeThumb(file,function(thumb){
        compress(file,function(b64,mime){
          if(!b64){ showStatus('❌ Cannot read image','#ef4444','rgba(239,68,68,.08)'); return; }

          var nn = String(n||'').trim() || (typeof curN!=='undefined'?String(curN||'').trim():'');
          if(!nn){ showStatus('❌ No job selected','#ef4444','rgba(239,68,68,.08)'); return; }

          // Add to localStorage as uploading
          var idx=pushPhoto(nn,{status:'uploading',thumb:thumb,ts:Date.now()});
          _session++;
          refreshGrid(nn);
          updateAddBtn();
          showStatus('⏳ Uploading photo '+_session+' of '+MAX_PER_VISIT+'...','#f59e0b','rgba(245,158,11,.08)');

          uploadOne(nn,b64,mime,function(resp,err){
            if(err){
              updatePhoto(nn,idx,{status:'failed'});
              refreshGrid(nn);
              showStatus('❌ Failed: '+err+'. Tap × on the photo to remove & retake.','#ef4444','rgba(239,68,68,.08)');
              return;
            }
            updatePhoto(nn,idx,{status:'done',url:resp.url||'',name:resp.name||''});
            refreshGrid(nn);
            showStatus('✔ Photo '+_session+' saved to Drive!','#22c55e','rgba(34,197,94,.08)');
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

  // ── Inject section into modal ─────────────────────────────────────────
  function inject(n){
    if(!n) return;
    // Always remove old section first for a fresh start
    var old=document.getElementById('ppSection');
    if(old&&old.parentNode) old.parentNode.removeChild(old);

    var ma=document.querySelector('.ma'); if(!ma) return;
    var sec=buildSection(n);
    ma.parentNode.insertBefore(sec, ma);
  }

  // ── Remove section & reset session counter ────────────────────────────
  function remove(){
    var s=document.getElementById('ppSection');
    if(s&&s.parentNode) s.parentNode.removeChild(s);
    _session=0;
  }

  // ── MutationObserver: watch modal overlay for open/close ──────────────
  // More reliable than curN polling — detects EVERY modal open, even same job
  function watchModal(){
    var mOv=document.getElementById('mOv');
    if(!mOv){
      // DOM not ready yet — retry
      setTimeout(watchModal, 300);
      return;
    }

    var observer=new MutationObserver(function(mutations){
      mutations.forEach(function(m){
        if(m.attributeName!=='class') return;
        var hidden=mOv.classList.contains('hidden');
        if(hidden){
          // ── Modal closed ───────────────────────────────────────────────
          remove();
        } else {
          // ── Modal opened — inject fresh section ────────────────────────
          setTimeout(function(){
            var n=(typeof curN!=='undefined') ? curN : null;
            if(n) inject(n);
          }, 120);
        }
      });
    });

    observer.observe(mOv,{attributes:true, attributeFilter:['class']});
  }

  // Start watching when DOM is ready
  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded', watchModal);
  } else {
    watchModal();
  }

})();
