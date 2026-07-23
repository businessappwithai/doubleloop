package com.example.todoapp

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.lifecycle.viewmodel.compose.viewModel
import com.example.todoapp.ui.screens.TodoScreen
import com.example.todoapp.ui.theme.TodoAppTheme
import com.example.todoapp.viewmodel.TodoViewModel

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            TodoAppTheme {
                val vm: TodoViewModel = viewModel()
                TodoScreen(viewModel = vm)
            }
        }
    }
}
