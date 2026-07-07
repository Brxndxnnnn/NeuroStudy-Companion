/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: 'http://139.59.126.77/api/:path*',
      },
    ]
  },
}

export default nextConfig;