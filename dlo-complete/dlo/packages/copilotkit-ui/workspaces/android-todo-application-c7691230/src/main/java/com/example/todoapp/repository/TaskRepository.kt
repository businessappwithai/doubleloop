package com.example.todoapp.repository

import com.example.todoapp.data.Priority
import com.example.todoapp.data.Task
import com.example.todoapp.data.TaskDao
import kotlinx.coroutines.flow.Flow
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class TaskRepository @Inject constructor(
    private val taskDao: TaskDao
) {
    val allTasks: Flow<List<Task>> = taskDao.getAllTasks()
    val pendingTasks: Flow<List<Task>> = taskDao.getPendingTasks()
    val completedTasks: Flow<List<Task>> = taskDao.getCompletedTasks()
    val pendingTaskCount: Flow<Int> = taskDao.getPendingTaskCount()

    fun getTasksByPriority(priority: Priority): Flow<List<Task>> =
        taskDao.getTasksByPriority(priority)

    fun searchTasks(query: String): Flow<List<Task>> =
        taskDao.searchTasks(query)

    suspend fun getTaskById(taskId: Long): Task? =
        taskDao.getTaskById(taskId)

    suspend fun insertTask(task: Task): Long =
        taskDao.insertTask(task)

    suspend fun updateTask(task: Task) =
        taskDao.updateTask(task)

    suspend fun deleteTask(task: Task) =
        taskDao.deleteTask(task)

    suspend fun deleteTaskById(taskId: Long) =
        taskDao.deleteTaskById(taskId)

    suspend fun deleteCompletedTasks() =
        taskDao.deleteCompletedTasks()
}
