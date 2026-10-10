import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {ChevronLeft,ChevronRight,Loader2,Maximize2,Minus,Plus,X} from 'lucide-react';
import './image-viewer.css';

export default function ImageViewer({src,alt='照片',onClose,navigation}) {
  const dialog=useRef(null),frame=useRef(null),picture=useRef(null),close=useRef(onClose),group=useRef(navigation),interaction=useRef(null),anchor=useRef(null),pan=useRef(null);
  const [zoom,setZoom]=useState(0),[size,setSize]=useState({src:'',width:0,height:0}),[bounds,setBounds]=useState({width:1,height:1}),[failed,setFailed]=useState(false),[dragging,setDragging]=useState(false);
  close.current=onClose;group.current=navigation;
  useEffect(()=>{
    const element=dialog.current,previous=document.activeElement,overflow=document.body.style.overflow;
    document.body.style.overflow='hidden';element.showModal();
    const observer=new ResizeObserver(([entry])=>setBounds({width:entry.contentRect.width,height:entry.contentRect.height}));
    observer.observe(frame.current);
    const wheel=event=>{
      if(!interaction.current?.ready) return;
      event.preventDefault();event.stopPropagation();
      const delta=event.deltaY*(event.deltaMode===1 ? 16 : event.deltaMode===2 ? frame.current.clientHeight : 1);
      interaction.current.change(interaction.current.scale*Math.exp(-Math.max(-300,Math.min(300,delta))*.002),event.clientX,event.clientY);
    };
    frame.current.addEventListener('wheel',wheel,{passive:false});
    // Keep navigation and dismissal in the topmost viewer.
    const keyboard=event=>{
      if(event.key==='Escape') {event.preventDefault();event.stopPropagation();close.current();}
      else if(event.key==='ArrowLeft' || event.key==='ArrowRight') {
        event.preventDefault();event.stopPropagation();
        const current=group.current,delta=event.key==='ArrowLeft' ? -1 : 1;
        if(current && current.index+delta>=0 && current.index+delta<current.total) current.onMove(delta);
      } else if(event.key==='Tab') event.stopPropagation();
    };
    document.addEventListener('keydown',keyboard,true);
    return ()=>{observer.disconnect();frame.current?.removeEventListener('wheel',wheel);document.removeEventListener('keydown',keyboard,true);element.close();document.body.style.overflow=overflow;previous?.focus();};
  },[]);
  const loading=size.src!==src && !failed,ready=Boolean(size.width && !loading && !failed);
  const fit=size.width ? Math.min(1,bounds.width/size.width,bounds.height/size.height) : 1,scale=zoom || fit;
  const minimum=Math.min(.1,fit);
  const changeZoom=(value,clientX,clientY)=>{
    const viewport=frame.current.getBoundingClientRect(),image=picture.current?.getBoundingClientRect();
    if(!image?.width || !ready) return;
    const x=clientX ?? viewport.left+frame.current.clientWidth/2,y=clientY ?? viewport.top+frame.current.clientHeight/2;
    anchor.current={u:Math.max(0,Math.min(1,(x-image.left)/image.width)),v:Math.max(0,Math.min(1,(y-image.top)/image.height)),x:x-viewport.left,y:y-viewport.top};
    const next=value===0 ? 0 : Math.max(minimum,Math.min(4,value));
    interaction.current.scale=next || fit;setZoom(next);
  };
  interaction.current={scale,ready,change:changeZoom};
  useLayoutEffect(()=>{
    if(!anchor.current || !picture.current) return;
    const {u,v,x,y}=anchor.current,canvas=picture.current.parentElement;
    frame.current.scrollLeft=(canvas.clientWidth-picture.current.width)/2+u*picture.current.width-x;
    frame.current.scrollTop=(canvas.clientHeight-picture.current.height)/2+v*picture.current.height-y;
    anchor.current=null;
  },[scale,size,bounds]);
  // Keep the fitted image box while loading; never paint an unknown image at natural size.
  useLayoutEffect(()=>{setZoom(0);setFailed(false);anchor.current=null;pan.current=null;setDragging(false);if(frame.current) {frame.current.scrollLeft=0;frame.current.scrollTop=0;}},[src]);
  const startPan=event=>{
    if(event.button!==0 || pan.current || !ready) return;
    const viewport=frame.current;
    if(viewport.scrollWidth<=viewport.clientWidth && viewport.scrollHeight<=viewport.clientHeight) return;
    event.preventDefault();viewport.setPointerCapture(event.pointerId);
    pan.current={id:event.pointerId,x:event.clientX,y:event.clientY,left:viewport.scrollLeft,top:viewport.scrollTop};setDragging(true);
  };
  const movePan=event=>{const drag=pan.current;if(!drag || drag.id!==event.pointerId) return;frame.current.scrollLeft=drag.left+drag.x-event.clientX;frame.current.scrollTop=drag.top+drag.y-event.clientY;};
  const endPan=event=>{if(pan.current?.id!==event.pointerId) return;pan.current=null;setDragging(false);if(frame.current.hasPointerCapture(event.pointerId)) frame.current.releasePointerCapture(event.pointerId);};
  return createPortal(<dialog ref={dialog} className="pc-image-viewer" aria-label="照片放大檢視" onCancel={event=>{event.preventDefault();onClose();}} onMouseDown={event=>{if(event.target===event.currentTarget) onClose();}}>
    <div className="pc-image-viewer-header"><strong>{alt}</strong>{navigation?.total>1 && <div className="pc-image-viewer-navigation" role="group" aria-label="同組照片切換"><button aria-label="上一張同組照片" disabled={navigation.index<=0} onClick={()=>navigation.onMove(-1)}><ChevronLeft size={19}/></button><span aria-live="polite" aria-atomic="true">{navigation.index+1} / {navigation.total}</span><button aria-label="下一張同組照片" disabled={navigation.index+1>=navigation.total} onClick={()=>navigation.onMove(1)}><ChevronRight size={19}/></button></div>}<div className="pc-image-viewer-tools"><button aria-label="縮小照片" disabled={!ready || scale<=minimum} onClick={()=>changeZoom(scale/1.4)}><Minus size={18}/></button><span aria-live="polite">{loading ? '…' : failed ? '—' : `${Math.round(scale*100)}%`}</span><button aria-label="放大照片" disabled={!ready || scale>=4} onClick={()=>changeZoom(scale*1.4)}><Plus size={18}/></button><button aria-label="適合畫面" disabled={!ready} aria-pressed={zoom===0} onClick={()=>changeZoom(0)}><Maximize2 size={16}/><span>適合畫面</span></button><button aria-label="實際大小" disabled={!ready} aria-pressed={zoom===1} onClick={()=>changeZoom(1)}>100%</button></div><button className="pc-image-viewer-close" aria-label="關閉放大檢視" onClick={onClose}><X size={22}/></button></div>
    <div ref={frame} className={`pc-image-viewer-frame ${dragging ? 'is-dragging' : ''} ${loading ? 'is-loading' : ''}`} aria-busy={loading} onPointerDown={startPan} onPointerMove={movePan} onPointerUp={endPan} onPointerCancel={endPan} onLostPointerCapture={endPan}>{failed ? <p role="alert">圖片暫時無法讀取，請關閉後重試。</p> : <><div className="pc-image-viewer-canvas"><img key={src} ref={picture} src={src} alt={alt} draggable={false} onLoad={event=>setSize({src,width:event.currentTarget.naturalWidth,height:event.currentTarget.naturalHeight})} onError={()=>setFailed(true)} style={{width:size.width*scale,height:size.height*scale,visibility:loading ? 'hidden' : undefined}}/></div>{loading && <div className="pc-image-viewer-loading" role="status"><Loader2 size={22} className="spin"/><span>讀取照片…</span></div>}</>}</div>
    <p className="pc-image-viewer-hint">{navigation?.total>1 && '←／→ 切換同組照片；'}滾輪放大、縮小；放大後拖曳查看細節。按 Esc 返回。</p>
  </dialog>,document.body);
}
