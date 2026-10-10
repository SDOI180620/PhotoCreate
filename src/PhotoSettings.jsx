import './photo-customization.css';

export default function PhotoSettings({settings=[],title='本張使用的提詞'}) {
  if(!settings.length) return null;
  return <section className="photo-settings" aria-label={title}><h3>{title}</h3><dl className="photo-settings-list">{settings.map(row=><div key={row.key}><dt>{row.label}{row.source==='custom' && <span>自訂</span>}</dt><dd>{row.value}{row.description && <small className="photo-clothing-description">拍攝描述：{row.description}</small>}</dd></div>)}</dl></section>;
}
