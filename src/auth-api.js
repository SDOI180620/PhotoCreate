export function checkAuthentication(response) {
  if(response.status===401) window.dispatchEvent(new Event('photocreate:auth-expired'));
}
export async function authApi(endpoint,body) {
  const response=await fetch(`/api/auth${endpoint}`,{method:body===undefined ? 'GET' : 'POST',headers:{'Content-Type':'application/json'},body:body===undefined ? undefined : JSON.stringify(body),cache:'no-store'});
  if(endpoint==='/session' && (!response.ok || !response.headers.get('content-type')?.includes('application/json'))) throw new Error('登入系統已更新，請重新啟動 PhotoCreate 服務後再試。');
  if(endpoint!=='/login') checkAuthentication(response);
  const result=await response.json();
  if(!response.ok) throw new Error(result.error || '操作未完成，請再試一次。');
  return result;
}
