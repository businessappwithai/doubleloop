package com.example.todoapp.data

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.TypeConverter
import androidx.room.TypeConverters

class PriorityConverter {
    @TypeConverter
    fun fromPriority(priority: Priority): String = priority.name

    @TypeConverter
    fun toPriority(value: String): Priority = Priority.valueOf(value)
}

class RecurrencePatternConverter {
    @TypeConverter
    fun fromPattern(pattern: RecurrencePattern): String = pattern.name

    @TypeConverter
    fun toPattern(value: String): RecurrencePattern = RecurrencePattern.valueOf(value)
}

@Database(
    entities = [Task::class],
    version = 1,
    exportSchema = false
)
@TypeConverters(PriorityConverter::class, RecurrencePatternConverter::class)
abstract class TodoDatabase : RoomDatabase() {

    abstract fun taskDao(): TaskDao

    companion object {
        @Volatile
        private var INSTANCE: TodoDatabase? = null

        fun getDatabase(context: Context): TodoDatabase {
            return INSTANCE ?: synchronized(this) {
                val instance = Room.databaseBuilder(
                    context.applicationContext,
                    TodoDatabase::class.java,
                    "todo_database"
                ).build()
                INSTANCE = instance
                instance
            }
        }
    }
}
