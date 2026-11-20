import { Injectable } from '@nestjs/common';
import { Observable, Subject, filter, map } from 'rxjs';

export interface FamilyRealtimeEvent {
  targetUserIds: string[];
  type: 'data_updated' | 'invite_received' | 'family_changed';
  timestamp: number;
}

@Injectable()
export class FamilyEventsService {
  private readonly subject = new Subject<FamilyRealtimeEvent>();

  emitToUsers(
    targetUserIds: string[],
    type: FamilyRealtimeEvent['type'] = 'data_updated',
  ) {
    if (!targetUserIds.length) return;
    this.subject.next({
      targetUserIds: Array.from(new Set(targetUserIds)),
      type,
      timestamp: Date.now(),
    });
  }

  streamForUser(userId: string): Observable<{ type: string; timestamp: number }> {
    return this.subject.asObservable().pipe(
      filter((event) => event.targetUserIds.includes(userId)),
      map((event) => ({
        type: event.type,
        timestamp: event.timestamp,
      })),
    );
  }
}
