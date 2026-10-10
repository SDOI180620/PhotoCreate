import {CheckCircle2} from 'lucide-react';
import './preset-review.css';

export default function PresetReview({reviewed}) {
  return reviewed ? <span className="preset-review-mark" role="img" aria-label="已確認" title="已確認"><CheckCircle2 size={15} aria-hidden="true"/></span> : null;
}
