/** @type {import('next').NextConfig} */
const nextConfig = {
  async redirects() {
    return [
      // keep existing redirects
      {
        source: '/r/conversation/:id',
        destination: '/dashboard/guest-experience/all?conversation=:id',
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
