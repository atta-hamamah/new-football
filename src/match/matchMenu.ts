import type { Stage } from '../render/app';
import { banner } from '../ui/dom';

export function showMatchMenu(_stage: Stage, _back: () => void): void {
  void banner('Coming soon', 'neutral');
}
