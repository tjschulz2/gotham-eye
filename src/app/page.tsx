"use client";

import Link from "next/link";

export default function Home() {
  return (
    <>
      <div className="fixed top-0 left-0 right-0 z-20 p-6 flex justify-between pointer-events-none animate-header">
        <h1 className="font-knockout text-white text-sm tracking-widest">GOTHAM EYE</h1>
        <div className="text-right">
          <p className="text-gray-500 text-xs mb-1">Data sources</p>
          <a 
            href="https://opendata.cityofnewyork.us/"
            target="_blank"
            rel="noopener noreferrer" 
            className="text-gray-400 text-sm block hover:text-gray-400 pointer-events-auto"
          >
            NYC
          </a>
          <a
            href="https://data.sfgov.org/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-gray-400 text-sm block hover:text-gray-400 pointer-events-auto"
          >
            SF
          </a>
        </div>
      </div>
      <div className="fixed inset-0 z-0 pointer-events-none bg-black flex items-center justify-center overflow-hidden">
        <video
          className="w-[150%] h-[150%] object-cover translate-y-[-3%]" 
          autoPlay
          muted
          loop
          playsInline
          preload="auto"
          src="/asciiearth.mp4"
        />
      </div>
      <div className="fixed inset-0 z-[5] pointer-events-none bg-black/60" />
      <div className="fixed bottom-0 left-0 right-0 z-[12] pointer-events-none px-6 pb-8">
        <p className="text-xl text-gray-400 text-center mb-4 leading-relaxed animate-hero-secondary">
          New York City. San Francisco.
        </p>
        <h1 className="font-cabinet text-white text-center font-bold leading-[0.9] text-[clamp(3rem,12vw,10rem)] animate-hero-primary">
          Know Where's Safe.
        </h1>
      </div>
      <div className="fixed inset-0 z-[11] flex items-center justify-center">
      <div className="text-center -translate-y-8 sm:-translate-y-12 md:-translate-y-16">
        <div className="flex flex-col items-center gap-3">
          <Link 
            href="/map"
            className="group inline-flex items-center gap-2 bg-white text-black px-16 py-4 text-lg font-semibold hover:bg-gray-300 transition-colors duration-200 shadow-lg animate-button"
          >
            Explore
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              className="w-5 h-5 inline-block arrow-icon"
              aria-hidden
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
            </svg>
          </Link>
          <a
            href="https://github.com"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block text-white/90 font-semibold animate-button transition-colors duration-200 hover:text-gray-300 mt-2"
          >
            Contribute
          </a>
        </div>
      </div>
      </div>
    </>
  );
}