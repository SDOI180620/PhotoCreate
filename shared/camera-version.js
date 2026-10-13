export const DEFAULT_CAMERA_VERSION = '2511';
export const CAMERA_VERSIONS = [
  {id:'2511',label:'Qwen Image Edit 2511',file:'01 Qwen 2511 - 單圖 3D 相機換角度.json'},
  {id:'2.1',label:'Qwen Image 2.1 · Multiple-Angles v2',file:'03 Qwen Image 2.1 - 單圖 3D 相機換角度.json'},
];

export function cameraVersion(value = DEFAULT_CAMERA_VERSION) {
  const version = CAMERA_VERSIONS.find(row => row.id === value);
  if(!version) throw new Error('相機拍攝版本無效，請選擇 2511 或 2.1。');
  return version;
}

export const cameraWorkflowPath = value => `PhotoCreate/${cameraVersion(value).file}`;
export const cameraBundlePath = value => `workflows/Qwen Multiangle/${cameraVersion(value).file}`;

// Read the encoder used by the sampler so saved jobs keep their own version.
export function cameraWorkflowVersion(graph) {
  const sampler = Object.values(graph || {}).find(node => node.class_type === 'KSampler');
  const encoder = graph?.[sampler?.inputs.positive?.[0]];
  return encoder?.class_type === 'TextEncodeQwenImage21' ? '2.1' : DEFAULT_CAMERA_VERSION;
}
