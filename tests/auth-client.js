const nativeFetch=globalThis.fetch;
const administrators=new Map();

export async function login(base,username='admin153',password='admin153',cookie='') {
  const response=await nativeFetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json',...(cookie ? {Cookie:cookie} : {})},body:JSON.stringify({username,password})});
  if(!response.ok) throw new Error(`Test login failed (${response.status}): ${await response.text()}`);
  return {cookie:response.headers.get('set-cookie').split(';')[0],user:(await response.json()).user,headers:response.headers};
}

// Existing production tests now exercise the same password login as the UI.
export async function adminFetch(resource,options={}) {
  const url=new URL(typeof resource==='string' ? resource : resource.url);
  if(new Headers(options.headers).has('cookie')) return nativeFetch(resource,options);
  if(!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/uploads/')) return nativeFetch(resource,options);
  const key=url.origin;
  if(!administrators.has(key)) administrators.set(key,login(key).catch(error=>{administrators.delete(key);throw error;}));
  const session=await administrators.get(key),headers=new Headers(options.headers);
  if(!headers.has('cookie')) headers.set('cookie',session.cookie);
  return nativeFetch(resource,{...options,headers});
}

export async function loginBrowser(page,base,username='admin153',password='admin153') {
  await page.goto(base+'/login');
  await page.getByRole('textbox',{name:'帳號',exact:true}).fill(username);
  await page.getByLabel('密碼',{exact:true}).fill(password);
  await page.getByRole('button',{name:'登入',exact:true}).click();
  await page.waitForURL(base+(username==='admin153' ? '/admin' : '/'));
}
