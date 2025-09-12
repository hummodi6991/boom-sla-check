export const prisma = {
  conversation: {
    async findUnique(_args: { where: { legacyId: number }; select?: { uuid: boolean } }) {
      return null;
    },
  },
};
