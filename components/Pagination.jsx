export function Pagination({ onPrev, onNext, canGoPrev = true, canGoNext = true }) {
  return (
    <div className="flex items-center justify-center gap-4 mt-12 w-full">
        <button
          onClick={onPrev}
          disabled={!canGoPrev}
          className={`flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-lg transition-colors shadow-sm ${
            canGoPrev
              ? 'text-gray-600 hover:bg-gray-50 hover:text-gray-900 cursor-pointer'
              : 'text-gray-300 cursor-not-allowed opacity-50'
          }`}
        >
            <span className="material-symbols-outlined text-lg">arrow_back</span>
            上一页
        </button>
        <button
          onClick={onNext}
          disabled={!canGoNext}
          className={`flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-lg transition-colors shadow-sm ${
            canGoNext
              ? 'text-gray-600 hover:bg-gray-50 hover:text-gray-900 cursor-pointer'
              : 'text-gray-300 cursor-not-allowed opacity-50'
          }`}
        >
            下一页
            <span className="material-symbols-outlined text-lg">arrow_forward</span>
        </button>
    </div>
  );
};
