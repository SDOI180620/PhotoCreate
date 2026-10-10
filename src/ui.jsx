import { Images, Search, X } from 'lucide-react';

export function Empty({icon:Icon = Images,title,description,children}) {
  return <div className="empty-state"><div className="empty-icon"><Icon size={34} strokeWidth={1.2}/></div><h3>{title}</h3><p>{description}</p>{children}</div>;
}

export function SearchBox({value,onChange,placeholder = '搜尋名稱、標籤或提詞…',className = '',disabled = false}) {
  return <div className={`search-box ${className}`}><Search size={17}/><input disabled={disabled} aria-label={placeholder} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}/>{value && <button disabled={disabled} className="icon-button" aria-label="清除搜尋" onClick={() => onChange('')}><X size={14}/></button>}</div>;
}
