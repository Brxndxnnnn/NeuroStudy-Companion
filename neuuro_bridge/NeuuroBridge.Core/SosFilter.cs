namespace NeuuroBridge
{
    /// <summary>
    /// A causal IIR filter given as cascaded second-order sections, each row
    /// {b0, b1, b2, a0, a1, a2} with a0 = 1 — the layout scipy.signal.butter(..., output='sos')
    /// prints, so a filter designed and checked in Python can be pasted in unchanged. Direct Form
    /// II Transposed, same as <see cref="LowPassFilter"/>. One instance per channel.
    /// </summary>
    public sealed class SosFilter
    {
        private readonly double[][] _sos;
        private readonly double[] _s1, _s2;

        public SosFilter(double[][] sos)
        {
            _sos = sos;
            _s1 = new double[sos.Length];
            _s2 = new double[sos.Length];
        }

        public double Process(double x)
        {
            for (int k = 0; k < _sos.Length; k++)
            {
                var c = _sos[k];
                double y = c[0] * x + _s1[k];
                _s1[k] = c[1] * x - c[4] * y + _s2[k];
                _s2[k] = c[2] * x - c[5] * y;
                x = y;
            }
            return x;
        }
    }
}
