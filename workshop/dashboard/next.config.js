/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',  // Static export for Vercel
  images: { unoptimized: true },
};

module.exports = nextConfig;
