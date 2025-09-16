type ConvRow = { uuid: string; legacyId?: number; slug?: string };
const conversations = new Map<number, ConvRow>();
const aliases = new Map<number, { legacy_id: number; uuid: string; slug?: string; last_seen_at: Date }>();

export const prisma = {
  conversation: {
    _data: conversations,
    async findFirst(args: any) {
      const where = args?.where ?? {};
      if (where.legacyId != null) {
        const row = conversations.get(Number(where.legacyId));
        if (!row) return null;
        return args?.select?.uuid ? { uuid: row.uuid } : row;
      }
      if (where.slug != null) {
        for (const row of conversations.values()) {
          if (row.slug === where.slug) {
            return args?.select?.uuid ? { uuid: row.uuid } : row;
          }
        }
      }
      return null;
    },
    async findUnique(args: any) {
      const uuid = args?.where?.uuid;
      if (!uuid) return null;
      for (const row of conversations.values()) {
        if (row.uuid === uuid) return row;
      }
      return null;
    },
  },
  conversation_aliases: {
    _data: aliases,
    async findFirst(args: any) {
      const where = args?.where ?? {};
      let row: any = null;
      if (where.legacy_id != null) {
        row = aliases.get(Number(where.legacy_id)) || null;
      }
      if (!row && where.slug != null) {
        for (const candidate of aliases.values()) {
          if (candidate?.slug === where.slug) {
            row = candidate;
            break;
          }
        }
      }
      if (!row) return null;
      if (args?.select?.uuid) return { uuid: row.uuid };
      return row;
    },
    async findUnique(args: any) {
      const legacy = args?.where?.legacy_id;
      if (legacy == null) return null;
      return aliases.get(Number(legacy)) || null;
    },
    async upsert(args: any) {
      const legacy = Number(args?.where?.legacy_id);
      const existing = aliases.get(legacy);
      if (existing) {
        const updated = {
          ...existing,
          ...args.update,
          last_seen_at: args.update?.last_seen_at ?? new Date(),
        };
        aliases.set(legacy, updated);
        return updated;
      }
      const created = {
        legacy_id: legacy,
        uuid: args.create?.uuid,
        slug: args.create?.slug,
        last_seen_at: args.create?.last_seen_at ?? new Date(),
      };
      aliases.set(legacy, created);
      return created;
    },
  },
};
