export const isComfyWidget=([type,options={}])=>!options.hidden && !options.socketless && (Array.isArray(type) || ['STRING','INT','FLOAT','BOOLEAN','COMBO','COMFY_DYNAMICCOMBO_V3'].includes(type));
export const widgetDefault=([type,options={}])=>options.default ?? (Array.isArray(type) ? type[0] : type==='COMFY_DYNAMICCOMBO_V3' ? options.options?.[0]?.key : options.options?.[0] ?? (type==='STRING' || type==='COMBO' ? '' : type==='BOOLEAN' ? false : 0));

// Dynamic ComfyUI widgets serialize their selected branch immediately after the
// selector. Yield lazily: the caller fills values before we choose that branch.
export function* comfyInputFields(schema,valueFor,prefix='') {
  const required=schema.input?.required || {},optional=schema.input?.optional || {},fields={...required,...optional};
  const names=[...(schema.input_order?.required || Object.keys(required)),...(schema.input_order?.optional || Object.keys(optional))];
  for(const key of names) {
    const name=prefix ? prefix+'.'+key : key,spec=fields[key];
    yield [name,spec,Object.hasOwn(required,key)];
    if(spec[0]==='COMFY_DYNAMICCOMBO_V3' && !spec[1]?.hidden) {
      const value=valueFor(name),branch=spec[1]?.options?.find(option=>option.key===value);
      if(!branch) throw new Error(`工作流的 ${name} 選項無效：${String(value)}`);
      yield* comfyInputFields({input:branch.inputs,input_order:branch.input_order},valueFor,name);
    }
  }
}
