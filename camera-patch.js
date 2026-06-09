/* camera-patch.js — Mandatory Photo Proof of Completion
   Uses capture-phase click interception — most reliable method on all devices */

(function(){
  'use strict';

  var _photoB64  = null;
  var _photoMime = 'image/jpeg';
  var _uploading = false;

  // ── Compress image via Canvas ─────────────────────────────────────────────
  function compressImage(file, cb){
    try{
      var reader = new FileReader();
      reader.onload = function(ev){
        var img = new Image();
        img.onload = function(){
          var MAX=1024, w=img.width, h=img.height;
          if(w>MAX){ h=Math.round(h*MAX/w); w=MAX; }
          if(h>MAX){ w=Math.round(w*MAX/h); h=MAX; }
          var cv=document.createElement('canvas');
          cv.width=w; cv.height=h;
          cv.getContext('2d').drawImage(img,0,0,w,h);
          var d=cv.toDataURL('image/jpeg',0.75);
          cb(d.split(',')[1],'image/jpeg');
        };
        img.onerror=function(){ cb(null,'Cannot read image'); };
        img.src=ev.target.result;
      };
      reader.onerror=function(){ cb(null,'Cannot read file'); };
      reader.readAsDataURL(file);
    }catch(e){ cb(null,e.message); }
  }

  // ── Upload to Apps Script (POST) ─────────────────────────────────────────
  function uploadPhoto(notifNo, b64, mime, cb){
    try{
      if(typeof _wbUrl==='undefined'||!_wbUrl){ cb(null,'No Apps Script URL'); return; }
      fetch(_wbUrl,{
        method:'POST',
        headers:{'Content-Type':'text/plain'},
        body:JSON.stringify({action:'savePhoto',notifNo:notifNo,photoData:b64,mimeType:mime})
      })
      .then(function(r){ return r.json(); })
      .then(function(d){ d.ok ? cb(d.url,null) : cb(null,d.msg||'Failed'); })
      .catch(function(e){ cb(null,e.message); });
    }catch(e){ cb(null,e.message); }
  }

  // ── Build camera section HTML ─────────────────────────────────────────────
  function buildCamSection(){
    var wrap=document.createElement('div');
    wrap.id='camSection';
    wrap.style.cssText='padding:12px;background:rgba(99,102,241,.06);border:1px solid rgba(99,102,241,.3);border-radius:10px;margin:8px 0 4px';

    var heading=document.createElement('div');
    heading.style.cssText='font-size:12px;font-weight:700;color:#818cf8;margin-bottom:8px';
    heading.innerHTML='📷 Photo Proof <span style="color:#ef4444">*</span> '
      +'<span style="font-weight:400;color:#94a3b8;font-size:10px">required to complete</span>';

    // Hidden file input — accept="image/*" shows both camera + gallery on phone
    var inp=document.createElement('input');
    inp.type='file'; inp.id='camInput'; inp.accept='image/*';
    inp.style.cssText='position:fixed;top:-200px;left:-200px;width:1px;height:1px;opacity:0';

    // Label = reliable native trigger on iOS + Android (no JS .click() needed)
    var lbl=document.createElement('label');
    lbl.id='camLbl'; lbl.htmlFor='camInput';
    lbl.style.cssText='display:block;width:100%;padding:11px;'
      +'background:rgba(99,102,241,.12);border:1px solid rgba(99,102,241,.4);'
      +'color:#818cf8;border-radius:8px;cursor:pointer;font-size:13px;'
      +'font-weight:600;text-align:center;box-sizing:border-box';
    lbl.innerHTML='📷 Take Photo / Choose from Gallery';

    var prev=document.createElement('div');
    prev.id='camPreview'; prev.style.display='none';

    var errDiv=document.createElement('div');
    errDiv.id='camErr';
    errDiv.style.cssText='display:none;font-size:11px;margin-top:6px;'
      +'padding:7px;border-radius:6px;text-align:center';

    // When file is selected → compress and preview
    inp.addEventListener('change',function(){
      var file=inp.files[0]; if(!file) return;
      _photoB64=null;
      lbl.innerHTML='⏳ Compressing...';
      lbl.style.pointerEvents='none'; lbl.style.opacity='0.6';

      compressImage(file,function(b64,mime){
        lbl.style.pointerEvents=''; lbl.style.opacity='';
        if(!b64){
          lbl.innerHTML='📷 Try Again';
          showErr('Could not process image. Please try another.','#ef4444');
          return;
        }
        _photoB64=b64; _photoMime=mime;
        var kb=Math.round(b64.length*0.75/1024);
        prev.innerHTML='<img src="data:image/jpeg;base64,'+b64+'" '
          +'style="max-width:100%;max-height:150px;border-radius:8px;'
          +'border:2px solid #22c55e;display:block;margin:0 auto 4px">'
          +'<span style="font-size:10px;color:#22c55e">✔ Ready — '+kb+' KB</span>';
        prev.style.display='block';
        lbl.innerHTML='📷 Change Photo';
        lbl.style.cssText='display:block;width:100%;padding:11px;'
          +'background:rgba(34,197,94,.12);border:1px solid rgba(34,197,94,.4);'
          +'color:#22c55e;border-radius:8px;cursor:pointer;font-size:13px;'
          +'font-weight:600;text-align:center;box-sizing:border-box';
        errDiv.style.display='none';
      });
    });

    function showErr(msg,color){
      errDiv.textContent=msg; errDiv.style.color=color||'#ef4444';
      errDiv.style.background=color==='#f59e0b'?'rgba(245,158,11,.08)':'rgba(239,68,68,.08)';
      errDiv.style.display='block';
    }
    wrap._showErr=showErr;

    wrap.appendChild(heading); wrap.appendChild(inp);
    wrap.appendChild(lbl);    wrap.appendChild(prev); wrap.appendChild(errDiv);
    return wrap;
  }

  // ── Find the Save button ──────────────────────────────────────────────────
  function findSaveBtn(){
    return document.querySelector('button[onclick="saveM()"]')
        || document.querySelector('button[onclick*="saveM"]')
        || document.querySelector('.sbtn');
  }

  // ── Inject camera section before Save button ──────────────────────────────
  function injectCamUI(){
    if(document.getElementById('camSection')) return;
    var btn=findSaveBtn(); if(!btn) return;
    btn.parentNode.insertBefore(buildCamSection(),btn);
  }

  // ── Remove camera section ─────────────────────────────────────────────────
  function removeCamUI(){
    var s=document.getElementById('camSection');
    if(s&&s.parentNode) s.parentNode.removeChild(s);
    _photoB64=null; _uploading=false;
  }

  // ── Reset when user opens a different job ─────────────────────────────────
  var _lastN=null;
  setInterval(function(){
    try{
      if(typeof curN!=='undefined'&&curN!==_lastN){ _lastN=curN; removeCamUI(); }
    }catch(e){}
  },300);

  // ── CORE: Capture-phase click listener on document ───────────────────────
  // Fires BEFORE any button onclick — no saveM override needed
  document.addEventListener('click', function(e){
    try{
      // Identify if the clicked element is the Save button
      var el=e.target;
      if(!el) return;

      var isSave=false;
      if(el.tagName==='BUTTON'){
        var oc=el.getAttribute('onclick')||'';
        isSave=(oc.indexOf('saveM')!==-1)||(el.className.indexOf('sbtn')!==-1);
      }
      if(!isSave) return;

      // Only intercept when status = Completed
      var statEl=document.getElementById('mStat');
      if(!statEl||statEl.value.toLowerCase()!=='completed') return;

      // Block the original onclick from firing
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      // If already uploading, do nothing
      if(_uploading) return;

      // Inject camera section if not there yet
      injectCamUI();

      var sec=document.getElementById('camSection');
      var errDiv=document.getElementById('camErr');

      function showErr(msg,color){
        if(!errDiv) return;
        errDiv.textContent=msg; errDiv.style.color=color||'#ef4444';
        errDiv.style.background=color==='#f59e0b'?'rgba(245,158,11,.08)':'rgba(239,68,68,.08)';
        errDiv.style.display='block';
      }

      // No photo selected yet → show message and scroll to section
      if(!_photoB64){
        showErr('📷 Please take or select a photo to continue.');
        if(sec) sec.scrollIntoView({behavior:'smooth',block:'nearest'});
        return;
      }

      // Photo ready → upload then save
      _uploading=true;
      var saveBtn=findSaveBtn();
      if(saveBtn){ saveBtn.disabled=true; saveBtn.textContent='⏳ Uploading...'; }
      showErr('⏳ Uploading photo to Google Drive...','#f59e0b');

      var notif=(typeof curN!=='undefined')?curN:'';
      var b64=_photoB64, mime=_photoMime;

      uploadPhoto(notif,b64,mime,function(url,err){
        _uploading=false;
        if(saveBtn){ saveBtn.disabled=false; saveBtn.textContent='Save & Mark Complete'; }

        if(err){
          showErr('❌ Upload failed: '+err+'. Tap Save to retry.');
          return;
        }

        // Store Drive link in jobData
        try{
          if(notif&&typeof jobData!=='undefined'){
            if(!jobData[notif]) jobData[notif]={};
            jobData[notif].photoUrl=url;
          }
        }catch(e2){}

        showErr('✔ Photo uploaded!','#22c55e');
        removeCamUI();

        // Now call the original saveM
        setTimeout(function(){
          try{
            if(typeof saveM==='function') saveM();
          }catch(e3){ console.warn('saveM error:',e3.message); }
        },300);
      });

    }catch(e){ console.warn('camera-patch click error:',e.message); }

  }, true); // <-- true = capture phase, fires before onclick

})();
