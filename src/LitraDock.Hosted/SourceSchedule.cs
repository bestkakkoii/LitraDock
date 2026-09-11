namespace Literature.Service;

public static class SourceSchedule
{
    public static DateTime? NcbiResume(DateTime utc, bool largePlannedBatch, int used)
    {
        var eastern = TimeZoneInfo.FindSystemTimeZoneById("America/New_York");
        var local = TimeZoneInfo.ConvertTimeFromUtc(utc, eastern);
        if (
            local.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday
            || local.Hour < 5
            || local.Hour >= 21
            || (!largePlannedBatch && used < 100)
        )
            return null;
        return TimeZoneInfo.ConvertTimeToUtc(local.Date.AddHours(21), eastern);
    }
}
