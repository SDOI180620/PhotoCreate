// Keep original URLs for viewers, downloads and generation references.
export function imagePreview(src,size='card') {
  if(typeof src!=='string' || !src.startsWith('/') || src.startsWith('//')) return src;
  const url=new URL(src,'http://photocreate.local');
  if(!/^\/uploads\/[^/]+$/.test(url.pathname) && !/^\/api\/(?:studio\/)?(?:jobs\/[^/]+\/(?:image\/\d+|character-reference)|(?:characters|garments)\/[^/]+\/image)$/.test(url.pathname)) return src;
  if(url.searchParams.has('download')) return src;
  url.searchParams.set('thumbnail',size==='small' ? 'small' : '1');
  return url.pathname+url.search+url.hash;
}
