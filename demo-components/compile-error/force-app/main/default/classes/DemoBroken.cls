public with sharing class DemoBroken {
    public static Integer total() {
        Integer a = 1;
        return a + undefinedVar; // DEMO: deliberate compile error (Variable does not exist)
    }
}
