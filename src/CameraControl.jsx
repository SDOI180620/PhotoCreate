import { useRef } from 'react';
import { CAMERA_HORIZONTAL, CAMERA_VERTICAL, CAMERA_ZOOM, DEFAULT_CAMERA_ANGLE, normalizeCameraAngle } from '../shared/camera.js';

const rad = value => value * Math.PI / 180;
const point = (h,v,r = 2.1) => [r * Math.sin(rad(h)) * Math.cos(rad(v)),r * Math.sin(rad(v)),r * Math.cos(rad(h)) * Math.cos(rad(v))];
const project = ([x,y,z]) => {
  const rx = x * Math.cos(rad(28)) + z * Math.sin(rad(28));
  const rz = z * Math.cos(rad(28)) - x * Math.sin(rad(28));
  return [240 + rx * 56,160 - (y * Math.cos(rad(25)) - rz * Math.sin(rad(25))) * 56];
};
const horizontalPoint = h => {const [x,,z] = point(h,0);return [x,-0.8,z];};
const controlPoint = (key,number,angle) => key === 'zoom' ? [435,70 + number * 18] : project(key === 'horizontalAngle' ? horizontalPoint(number) : point(angle.horizontalAngle,number));
const path = points => points.map((value,index) => `${index ? 'L' : 'M'}${project(value).join(',')}`).join(' ');
const controls = [
  {key:'horizontalAngle',label:'水平角度',unit:'°',min:0,max:360,step:1,choices:CAMERA_HORIZONTAL},
  {key:'verticalAngle',label:'俯仰角度',unit:'°',min:-90,max:60,step:1,choices:CAMERA_VERTICAL},
  {key:'zoom',label:'Zoom',unit:'',min:0,max:10,step:0.1,choices:CAMERA_ZOOM},
];

export default function CameraControl({value = DEFAULT_CAMERA_ANGLE,onChange,image}) {
  const svg = useRef(null),drag = useRef(null);
  const angle = normalizeCameraAngle(value);
  const change = (key,number) => {
    const item = controls.find(row => row.key === key);
    const next = Math.max(item.min,Math.min(item.max,number));
    onChange({...angle,[key]:key === 'zoom' ? Math.round(next * 10) / 10 : Math.round(next)});
  };
  const move = event => {
    if(!drag.current) return;
    const matrix = svg.current.getScreenCTM();if(!matrix) return;
    const {x,y} = new DOMPoint(event.clientX,event.clientY).matrixTransform(matrix.inverse());
    const key = drag.current,control = controls.find(row => row.key === key);
    let nearest = control.min,best = Infinity;
    for(let number = control.min;number <= control.max + 0.01;number += control.step) {
      const [px,py] = controlPoint(key,number,angle),distance = (px - x) ** 2 + (py - y) ** 2;
      if(distance < best) {best = distance;nearest = number;}
    }
    change(key,nearest);
  };
  const corners = [[-0.5,0.7,0],[0.5,0.7,0],[0.5,-0.7,0],[-0.5,-0.7,0]].map(project);
  const [origin,right,,bottom] = corners;
  const handlePoints = controls.map(item => controlPoint(item.key,angle[item.key],angle));
  const grid = Array.from({length:9},(_,index) => (index - 4) / 2);
  return <div className="camera-control">
    <p className="field-help">拖曳圓球調整方向、俯仰與遠近，也可以輸入數值。</p>
    <div className="camera-control-body"><svg ref={svg} className="camera-orbit" viewBox="0 0 480 320" aria-label="3D 相機角度控制" onPointerMove={move} onPointerUp={event => {drag.current = null;if(svg.current.hasPointerCapture(event.pointerId)) svg.current.releasePointerCapture(event.pointerId);}} onPointerCancel={() => {drag.current = null;}}>
      <g className="camera-floor">{grid.map(number => <g key={number}><path d={path([[number,-0.8,-2],[number,-0.8,2]])}/><path d={path([[-2,-0.8,number],[2,-0.8,number]])}/></g>)}</g>
      <path className="camera-orbit-ring horizontal" d={path(Array.from({length:73},(_,index) => horizontalPoint(index * 5)))}/>
      <path className="camera-orbit-ring vertical" d={path(Array.from({length:31},(_,index) => point(angle.horizontalAngle,-90 + index * 5)))}/>
      <path className="camera-orbit-ring distance" d={path([[0,0,0],point(angle.horizontalAngle,angle.verticalAngle,2.6)])}/>
      <path className="camera-orbit-ring distance" d="M435 70 L435 250"/>
      <text className="camera-distance-label" x="435" y="49" textAnchor="middle">遠近</text>
      <polygon className="camera-subject" points={corners.map(value => value.join(',')).join(' ')}/>
      {image ? <image href={image} width="100" height="100" preserveAspectRatio="xMidYMid meet" transform={`matrix(${(right[0]-origin[0])/100} ${(right[1]-origin[1])/100} ${(bottom[0]-origin[0])/100} ${(bottom[1]-origin[1])/100} ${origin[0]} ${origin[1]})`}/> : <g className="camera-subject-person"><circle cx="240" cy="141" r="10"/><path d="M223 179 Q223 154 240 154 Q257 154 257 179"/></g>}
      {controls.map((item,index) => <circle key={item.key} className={`camera-handle handle-${item.key}`} cx={handlePoints[index][0]} cy={handlePoints[index][1]} r="11" role="slider" tabIndex={0} aria-label={`拖球調${item.label}`} aria-valuemin={item.min} aria-valuemax={item.max} aria-valuenow={angle[item.key]} onPointerDown={event => {event.preventDefault();drag.current = item.key;svg.current.setPointerCapture(event.pointerId);}} onKeyDown={event => {if(['ArrowLeft','ArrowDown','ArrowRight','ArrowUp'].includes(event.key)) {event.preventDefault();change(item.key,angle[item.key] + (['ArrowLeft','ArrowDown'].includes(event.key) ? -1 : 1) * (item.key === 'zoom' ? 0.1 : 5));}}}><title>{item.label} {angle[item.key]}{item.unit}</title></circle>)}
    </svg>
    <div className="camera-numbers">{controls.map(item => <div key={item.key}><label>{item.label}<input type="number" aria-label={item.label} min={item.min} max={item.max} step={item.step} value={angle[item.key]} onChange={event => {if(event.target.value !== '') change(item.key,Number(event.target.value));}}/></label><input type="range" aria-label={`${item.label}滑桿`} min={item.min} max={item.max} step={item.step} value={angle[item.key]} onChange={event => change(item.key,Number(event.target.value))}/><select aria-label={`${item.label}快捷選擇`} value={item.choices.some(([number]) => number === angle[item.key]) ? angle[item.key] : ''} onChange={event => {if(event.target.value !== '') change(item.key,Number(event.target.value));}}><option value="">自訂</option>{item.choices.map(([number,label]) => <option key={number} value={number}>{label} {number}{item.unit}</option>)}</select></div>)}</div></div>
  </div>;
}
