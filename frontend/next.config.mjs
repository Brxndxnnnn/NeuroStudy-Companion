/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  async rewrites() {
    if (!process.env.BACKEND_PROXY_URL)
      return []

    return [
      {
        source: '/api/:path*',
        destination: `${process.env.BACKEND_PROXY_URL}/api/:path*`,
      },
    ]
  },
}

export default nextConfig