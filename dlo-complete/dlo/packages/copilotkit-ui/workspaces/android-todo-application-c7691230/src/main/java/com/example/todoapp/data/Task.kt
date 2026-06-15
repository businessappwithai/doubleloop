package com.example.todoapp.data

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.PrimaryKey

enum class Priority {
    HIGH,
    MEDIUM,
    LOW
}

enum class RecurrencePattern {
    NONE,
    DAILY,
    WEEKLY,
    MONTHLY,
    YEARLY
}

@Entity(tableName = "tasks")
data class Task(
    @PrimaryKey(autoGenerate = true)
    val id: Long = 0,

    @ColumnInfo(name = "title")
    val title: String,

    @ColumnInfo(name = "description")
    val description: String? = null,

    @ColumnInfo(name = "due_date_millis")
    val dueDateMillis: Long? = null,

    @ColumnInfo(name = "priority")
    val priority: Priority = Priority.MEDIUM,

    @ColumnInfo(name = "category")
    val category: String? = null,

    @ColumnInfo(name = "tags")
    val tags: String? = null,

    @ColumnInfo(name = "is_completed")
    val isCompleted: Boolean = false,

    @ColumnInfo(name = "completed_at_millis")
    val completedAtMillis: Long? = null,

    @ColumnInfo(name = "is_recurring")
    val isRecurring: Boolean = false,

    @ColumnInfo(name = "recurrence_pattern")
    val recurrencePattern: RecurrencePattern = RecurrencePattern.NONE,

    @ColumnInfo(name = "created_at_millis")
    val createdAtMillis: Long = System.currentTimeMillis(),

    @ColumnInfo(name = "updated_at_millis")
    val updatedAtMillis: Long = System.currentTimeMillis(),

    @ColumnInfo(name = "sync_status")
    val syncStatus: String = "PENDING",

    @ColumnInfo(name = "remote_id")
    val remoteId: String? = null
) {
    fun withCompletionStatus(completed: Boolean): Task {
        return if (completed && !isCompleted) {
            copy(
                isCompleted = true,
                completedAtMillis = System.currentTimeMillis(),
                updatedAtMillis = System.currentTimeMillis(),
                syncStatus = "PENDING"
            )
        } else if (!completed && isCompleted) {
            copy(
                isCompleted = false,
                completedAtMillis = null,
                updatedAtMillis = System.currentTimeMillis(),
                syncStatus = "PENDING"
            )
        } else {
            this
        }
    }

    fun isOverdue(): Boolean {
        return if (isCompleted || dueDateMillis == null) {
            false
        } else {
            System.currentTimeMillis() > dueDateMillis
        }
    }

    fun hasRecurrenceEnabled(): Boolean {
        return isRecurring && recurrencePattern != RecurrencePattern.NONE
    }

    fun getTagsList(): List<String> {
        return tags?.split(",")?.map { it.trim() }?.filter { it.isNotEmpty() } ?: emptyList()
    }

    fun withUpdatedTimestamp(): Task {
        return copy(updatedAtMillis = System.currentTimeMillis())
    }
}