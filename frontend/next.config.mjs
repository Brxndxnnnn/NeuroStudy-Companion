/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  async rewrites() {
    const rules = []

    if (process.env.BACKEND_PROXY_URL) {
      rules.push({
        source: '/api/:path*',
        destination: `${process.env.BACKEND_PROXY_URL}/api/:path*`,
      })
    }

    // The Insights tab calls the ML service at /ml/. In production nginx routes
    // it; in dev, proxy it to the same host as the API (or ML_PROXY_URL) so the
    // page is testable locally instead of 404-ing on the Next dev server.
    const mlProxy = process.env.ML_PROXY_URL || process.env.BACKEND_PROXY_URL
    if (mlProxy) {
      rules.push({
        source: '/ml/:path*',
        destination: `${mlProxy}/ml/:path*`,
      })
    }

    return rules
  },
}

export default nextConfig