import { SelectItem } from "@/components/ui/select";

type PeriodSelectItemsProps = {
  /** Include "All time" — omit on manager dashboard where all-time is not offered. */
  includeAll?: boolean;
};

export function PeriodSelectItems({ includeAll = true }: PeriodSelectItemsProps) {
  return (
    <>
      {includeAll && <SelectItem value="all">All time</SelectItem>}
      <SelectItem value="today">Today</SelectItem>
      <SelectItem value="yesterday">Yesterday</SelectItem>
      <SelectItem value="wtd">Week to date</SelectItem>
      <SelectItem value="week">Last 7 days</SelectItem>
      <SelectItem value="month">This month</SelectItem>
      <SelectItem value="quarter">This quarter</SelectItem>
      <SelectItem value="year">This year</SelectItem>
      <SelectItem value="custom">Custom</SelectItem>
    </>
  );
}
