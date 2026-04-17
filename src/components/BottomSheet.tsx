import { ReactNode, useState, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { X } from "lucide-react";

interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}

export function BottomSheet({ open, onClose, title, children, footer }: BottomSheetProps) {
  const [translateY, setTranslateY] = useState(0);
  const [dragging, setDragging] = useState(false);
  const startY = useRef(0);
  const sheetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setTranslateY(0);
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  const handleTouchStart = (e: React.TouchEvent) => {
    startY.current = e.touches[0].clientY;
    setDragging(true);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!dragging) return;
    const diff = e.touches[0].clientY - startY.current;
    if (diff > 0) setTranslateY(diff);
  };

  const handleTouchEnd = () => {
    setDragging(false);
    if (translateY > 120) {
      onClose();
    }
    setTranslateY(0);
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60]">
      <div className="absolute inset-0 bg-foreground/30 backdrop-blur-sm" onClick={onClose} />
      <div
        ref={sheetRef}
        className={cn(
          "absolute bottom-0 left-0 right-0 bg-card rounded-t-3xl max-h-[85vh] flex flex-col",
          !dragging && "transition-transform duration-300"
        )}
        style={{ transform: `translateY(${translateY}px)` }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        {/* Drag handle */}
        <div className="flex justify-center pt-3 pb-1 cursor-grab">
          <div className="w-10 h-1 rounded-full bg-muted-foreground/30" />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <h3 className="font-heading font-semibold text-foreground text-lg">{title}</h3>
          <button
            onClick={onClose}
            className="tap-scale inline-flex h-9 w-9 items-center justify-center rounded-full bg-muted text-foreground transition-colors hover:bg-muted/80"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {children}
        </div>

        {/* Sticky footer */}
        {footer && (
          <div className="sticky bottom-0 px-5 py-4 border-t bg-card">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
