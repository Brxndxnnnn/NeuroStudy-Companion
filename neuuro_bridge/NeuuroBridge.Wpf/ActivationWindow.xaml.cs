using System;
using System.Windows;
using System.Windows.Input;
using System.Windows.Media;

namespace NeuuroBridge.Wpf
{
    /// <summary>
    /// First-run enrollment dialog: takes the activation code, calls the backend, and
    /// writes the machine config store. Shown by App before MainWindow whenever the
    /// store is absent; closing it without activating exits the app.
    /// </summary>
    public partial class ActivationWindow : Window
    {
        public ActivationWindow()
        {
            InitializeComponent();
            MachineText.Text = $"Machine: {Environment.MachineName}";
            Loaded += (_, __) => CodeBox.Focus();
        }

        private void CodeBox_KeyDown(object sender, KeyEventArgs e)
        {
            if (e.Key == Key.Enter && ActivateBtn.IsEnabled) ActivateBtn_Click(sender, e);
        }

        private async void ActivateBtn_Click(object sender, RoutedEventArgs e)
        {
            var code = CodeBox.Text?.Trim();
            if (string.IsNullOrEmpty(code))
            {
                ShowStatus("Enter the activation code first.", isError: true);
                return;
            }

            ActivateBtn.IsEnabled = false;
            CodeBox.IsEnabled = false;
            ShowStatus("Contacting the activation server…", isError: false);
            try
            {
                var result = await ActivationClient.ActivateAsync(code);
                ActivationClient.SaveToStore(result);
                StatusText.Foreground = (Brush)FindResource("Good");
                StatusText.Text = $"Activated for {result.ClinicName ?? ("clinic " + result.ClinicId)}.";
                DialogResult = true;
                Close();
            }
            catch (ActivationException ex)
            {
                ShowStatus(ex.Message, isError: true);
                ActivateBtn.IsEnabled = true;
                CodeBox.IsEnabled = true;
                CodeBox.Focus();
            }
        }

        private void ShowStatus(string message, bool isError)
        {
            StatusText.Foreground = (Brush)FindResource(isError ? "Bad" : "Muted2");
            StatusText.Text = message;
        }
    }
}
