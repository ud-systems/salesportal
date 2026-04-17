import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

type RecordsLoadingOverlayProps = {
  rows?: number;
  className?: string;
};

export function RecordsLoadingOverlay({ rows = 5, className }: RecordsLoadingOverlayProps) {
  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-0 z-20 rounded-inherit bg-background/65 backdrop-blur-[1px] p-4",
        className,
      )}
      aria-hidden="true"
    >
      <div className="space-y-2">
        {Array.from({ length: rows }).map((_, idx) => (
          <Skeleton key={idx} className="h-10 w-full rounded-lg" />
        ))}
      </div>
    </div>
  );
}
