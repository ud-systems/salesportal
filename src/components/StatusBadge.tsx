import { cn } from "@/lib/utils";

type StatusType = "paid" | "pending" | "refunded" | "partially_paid" | "fulfilled" | "unfulfilled" | "partial";

const statusStyles: Record<StatusType, string> = {
  paid: "bg-primary/10 text-primary",
  pending: "bg-warning/10 text-warning",
  refunded: "bg-destructive/10 text-destructive",
  partially_paid: "bg-info/10 text-info",
  fulfilled: "bg-primary/10 text-primary",
  unfulfilled: "bg-warning/10 text-warning",
  partial: "bg-info/10 text-info",
};

const statusLabels: Record<StatusType, string> = {
  paid: "Paid",
  pending: "Pending",
  refunded: "Refunded",
  partially_paid: "Partial",
  fulfilled: "Fulfilled",
  unfulfilled: "Unfulfilled",
  partial: "Partial",
};

interface StatusBadgeProps {
  status: StatusType;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium font-body px-2.5 py-1 rounded-full", statusStyles[status])}>
      <span className={cn("h-1.5 w-1.5 rounded-full", status === "paid" || status === "fulfilled" ? "bg-primary" : status === "pending" || status === "unfulfilled" ? "bg-warning" : status === "refunded" ? "bg-destructive" : "bg-info")} />
      {statusLabels[status]}
    </span>
  );
}
