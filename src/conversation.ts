export type Reservation = {
  id: string;
  // additional fields can be added as needed
};

export type Conversation = {
  id: string;
  related_reservations?: Reservation[];
};

export function normalizeConversation(raw: any): Conversation {
  return {
    ...raw,
    related_reservations: Array.isArray(raw?.related_reservations)
      ? raw.related_reservations
      : [],
  };
}
