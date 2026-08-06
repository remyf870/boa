// In-process event bus feeding the live budget tracker SSE stream (plan §5.9).
// Emitters fire AFTER their transaction commits (never inside it) so a
// subscriber can immediately re-read a consistent position. Single-process by
// design: the MVP deploys one app server (plan §2); a multi-node deployment
// would move this to LISTEN/NOTIFY, which the emit call signature allows.
import { EventEmitter } from 'node:events';

export interface BudgetChangedEvent {
  costCentreId: string;
  /** What moved the figure: approval commits, posting actualises, etc. */
  cause: 'requisition_approved' | 'requisition_released' | 'invoice_posted' | 'budget_version_activated';
}

class AppEventBus extends EventEmitter {
  emitBudgetChanged(event: BudgetChangedEvent): void {
    this.emit('budget_changed', event);
  }

  onBudgetChanged(listener: (event: BudgetChangedEvent) => void): () => void {
    this.on('budget_changed', listener);
    return () => this.off('budget_changed', listener);
  }
}

export const eventBus = new AppEventBus();
// SSE can hold one listener per open screen; raise the default warning limit.
eventBus.setMaxListeners(500);
